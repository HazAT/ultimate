import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord/context'
import { copyJson } from '@earendil-works/chord/json'
import {
  AgentDoc,
  CompactionTask,
  defineDoc,
  defineExtension,
  defineTask,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type {
  ConversationId,
  Cursor,
  JsonObject,
  NextTaskState,
  TaskId,
  Tx,
} from '@earendil-works/pi-durable'
import {
  CACHE_WARMING_MAX_AGE_MS,
  calculateCost,
  getCacheWarmingDelayMs,
  getCacheWarmingRequestOptions,
  getPromptCacheTtlMs,
  isCacheWarmingReplayable,
} from '@earendil-works/pi-ai'
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  ThinkingLevel,
  Usage,
} from '@earendil-works/pi-ai'
import type { ExtensionHost } from '../../server/extensions.ts'
import { UserInputEvent } from '../../shared/events.ts'
import { discoverAgents } from '../../lib/agents.ts'
import { implementAction } from '../../lib/actions.ts'
import { compacting, admitCompaction } from '../../lib/compaction.ts'
import { rebuiltOnOpen } from '../../lib/errors.shared.ts'
import { conversationIdentity, parseConversationId } from '../../lib/ids.shared.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { ContextUsageDoc, ConversationsApi } from '../conversations/api.ts'
import type { ResponseReceipt } from '../conversations/summary.ts'
import { PauseApi } from '../pause/api.ts'
import { Profile, Standing } from '../subagents/api.ts'
import {
  decide,
  keptBy,
  lateRefreshCutoff,
  policyOf,
  resolvePolicy,
  streakAfterPing,
  timeline,
  warmWindowEnd,
} from './due.shared.ts'
import type { Situation } from './due.shared.ts'
import { WarmDoc, SetAction, StateAction } from './refs.ts'
import type { WarmDocState, WarmState, Compaction, Ping } from './refs.ts'
import { checkpointEvery } from '../../shared/checkpoint.ts'

const State = defineDoc<WarmDocState>({
  kind: WarmDoc.kind,
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
export const docs = [State]
export const order = -1

const PING_TIMEOUT_MS = 180_000
const SUMMARY_TIMEOUT_MS = 300_000
const SUMMARY_REQUEST =
  'Context compaction from Ultimate, not from the user: do not continue the work and call no tools. Write the summary this branch continues from, in Markdown. Keep its intent and progress toward it: decisions and who made them, open questions and what it waits for, changed files, verification, what remains. Preserve exact file paths, names and errors; cite entries as #<conversation>/<entry>. The most recent turns stay verbatim after the summary. Output only the summary.'
const OUTPUT_CAP_FIELD: Partial<Record<Api, string>> = {
  'anthropic-messages': 'max_tokens',
}
const CLAUDE_CODE_TTL_MS = 3_600_000
const DEFAULT_MAX_WARM = 5
const PING_QUESTION = 'Cache keep-warm check from Ultimate, not from the user. Reply with just: ok'
const UNSETTLED = ['pending', 'running', 'waiting', 'sleeping', 'completing'] as const

type Sent = { model: Model<Api>; at: number; payload?: unknown }

type Replay = Map<ConversationId, Sent>

type Kind = 'standing' | 'coordinator'

export const kindOf = (owned: boolean, label: string | undefined): Kind | undefined =>
  owned
    ? undefined
    : label === 'coordinator'
      ? 'coordinator'
      : label === 'agent'
        ? 'standing'
        : undefined

async function warmedKind(host: ExtensionHost, id: ConversationId) {
  const record = await host.harness().commit((tx) => tx.conversation(id), context)
  if (!record) return undefined
  const label = (await host.harness().snapshot(host.metadata, id, context))?.label
  return kindOf(record.owner !== undefined, label)
}

export function oneTokenPayload(api: Api, payload: unknown) {
  const field = OUTPUT_CAP_FIELD[api]
  if (!field || !payload || typeof payload !== 'object' || !(field in payload)) return undefined
  return { ...(payload as JsonObject), [field]: 1 }
}

const costOf = (model: Model<Api>, usage: Partial<Usage>) =>
  calculateCost(model, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...usage,
  }).total

export const rewriteCost = (model: Model<Api>, ttl: number, tokens: number) =>
  costOf(model, {
    cacheWrite: tokens,
    ...(ttl >= CLAUDE_CODE_TTL_MS ? { cacheWrite1h: tokens } : {}),
  })

export function warmCost(
  model: Model<Api>,
  delayBeforeRefresh: number,
  minutes: number,
  tokens: number,
) {
  const pings = Math.floor((minutes * 60_000) / delayBeforeRefresh)
  return { pings, cost: pings * costOf(model, { cacheRead: tokens }) }
}

export function cacheTiming(model: Model<Api>) {
  const ttl =
    model.provider === 'claude-code' ? CLAUDE_CODE_TTL_MS : getPromptCacheTtlMs(model, undefined)
  const delayBeforeRefresh = ttl === undefined ? undefined : getCacheWarmingDelayMs(ttl)
  return ttl === undefined || delayBeforeRefresh === undefined
    ? undefined
    : { ttl, delayBeforeRefresh }
}

const readDoc = async (host: ExtensionHost, id: ConversationId) =>
  (await host.harness().snapshot(State, id, context)) ?? {}

async function maxWarmBranches(host: ExtensionHost) {
  const user = await readSettings(userSettingsPath(host.userHome)).catch((error: unknown) => {
    host.notice(`Keep warm: ${String(error)}`)
    return {}
  })
  const project = await host.projectSettings()
  const of = (settings: JsonObject) => {
    const section = settings.keepWarm
    return section && typeof section === 'object' && !Array.isArray(section)
      ? section.maxWarm
      : undefined
  }
  const isCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
  return [of(project), of(user)].find(isCount) ?? DEFAULT_MAX_WARM
}

type Definitions = Awaited<ReturnType<typeof discoverAgents>>['definitions']

const discover = async (host: ExtensionHost) =>
  (await discoverAgents(host.ultimateRoot, host.projectRoot, host.userHome, host.modelRuntime))
    .definitions

async function policyFor(
  host: ExtensionHost,
  id: ConversationId,
  ttl: number | undefined,
  definitions: Definitions,
) {
  const kind = await warmedKind(host, id)
  const profile = await host.harness().snapshot(Profile, id, context)
  const name = profile?.definition ?? (kind === 'coordinator' ? 'coordinator' : undefined)
  const agent = name === undefined ? undefined : definitions.find((item) => item.name === name)
  const doc = await readDoc(host, id)
  const resolved = resolvePolicy(agent?.cache, doc, ttl)
  if (kind === 'standing') resolved.compact = { value: false, source: 'default' }
  return { kind, agent, doc, resolved, effective: policyOf(resolved) }
}

async function agentOf(host: ExtensionHost, id: ConversationId) {
  const conversation = await host.harness().conversation(id, context)
  return conversation && (await conversation.agent(context))
}

async function warmedBranches(host: ExtensionHost) {
  const ids = new Set<ConversationId>()
  await host.harness().commit(async (tx) => {
    for (const status of UNSETTLED) {
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanTasks({ kind: 'keep-warm.ping', status }, 100, cursor)
        for (const task of page.items) ids.add(task.conversationId)
        cursor = page.next
      } while (cursor)
    }
  }, context)
  return ids
}

async function withinMaxWarm(
  host: ExtensionHost,
  id: ConversationId,
  realRequestAt: number,
  definitions: Definitions,
) {
  const concluded = await host.need(ConversationsApi).concluded(context)
  const warming: { id: ConversationId; at: number }[] = [{ id, at: realRequestAt }]
  for (const other of await warmedBranches(host)) {
    if (other === id || concluded.has(other)) continue
    if ((await warmedKind(host, other)) !== 'coordinator') continue
    const { doc, effective } = await policyFor(host, other, undefined, definitions)
    if (effective.warm && doc.request) warming.push({ id: other, at: doc.request.at })
  }
  return warming
    .toSorted((a, b) => b.at - a.at || a.id - b.id)
    .slice(0, await maxWarmBranches(host))
    .some((entry) => entry.id === id)
}

type Planned =
  | { stop: string }
  | {
      model: Model<Api>
      situation: Situation
      step: ReturnType<typeof decide>
      dueStep: ReturnType<typeof decide>
      nextAt: number
      warmUntil: number
      replay?: Sent
    }

type Plan = Planned & { renewal: string }

async function planFor(
  host: ExtensionHost,
  replay: Replay,
  id: ConversationId,
  now: number | 'due',
  definitions: Definitions,
): Promise<Plan> {
  const renewal = await renewalOf(host, replay, id)
  return { ...(await planOf(host, replay, id, now, definitions)), renewal }
}

async function planOf(
  host: ExtensionHost,
  replay: Replay,
  id: ConversationId,
  now: number | 'due',
  definitions: Definitions,
): Promise<Planned> {
  const kind = await warmedKind(host, id)
  if (!kind || (await host.need(ConversationsApi).concluded(context)).has(id))
    return { stop: 'Not a standing agent or an open branch' }
  const ref = (await agentOf(host, id))?.model
  const model = ref && host.modelRuntime.getModel(ref.provider, ref.modelId)
  if (!model) return { stop: 'No model' }
  const timing = cacheTiming(model)
  if (!timing) return { stop: 'Model has no known cache lifetime' }
  const { doc, effective } = await policyFor(host, id, timing.ttl, definitions)
  const known = timeline(doc.request, doc.last, model)
  if ('stop' in known) return known
  const latest = replay.get(id)
  const sent = latest?.model.id === model.id ? latest : undefined
  const lastCacheRequestAt = Math.max(known.lastCacheRequestAt, sent?.at ?? 0)
  const nextAt = lastCacheRequestAt + timing.delayBeforeRefresh
  const usage = await host.harness().snapshot(ContextUsageDoc, id, context)
  const fromInput = kind === 'standing'
  const situation: Situation = {
    now: now === 'due' ? nextAt : now,
    ...timing,
    realRequestAt: known.realRequestAt,
    lastCacheRequestAt,
    from: fromInput ? 'input' : 'request',
    windowStart: fromInput ? doc.inputAt : known.realRequestAt,
    runActive: Boolean((await host.harness().snapshot(LiveDoc, id, context))?.run),
    withinMaxWarm:
      kind !== 'coordinator' || (await withinMaxWarm(host, id, known.realRequestAt, definitions)),
    tokens: usage?.tokens ?? 0,
    compactedSinceRequest: (doc.compaction?.at ?? 0) >= known.realRequestAt,
  }
  return {
    model,
    situation,
    step: decide(situation, effective),
    dueStep: decide({ ...situation, now: nextAt }, effective),
    nextAt,
    warmUntil: warmWindowEnd(situation, effective),
    ...(sent?.payload !== undefined ? { replay: sent } : {}),
  }
}

const renewalKey = (
  doc: WarmDocState,
  agent: { model?: { provider: string; modelId: string }; thinkingLevel?: string } | undefined,
  sent: Sent | undefined,
) =>
  JSON.stringify([
    doc.request,
    doc.last,
    doc.warm,
    doc.compact,
    doc.minutes,
    doc.inputAt,
    agent?.model,
    agent?.thinkingLevel,
    sent?.at,
  ])

async function renewalOf(host: ExtensionHost, replay: Replay, id: ConversationId) {
  return renewalKey(
    await readDoc(host, id),
    await host.harness().snapshot(AgentDoc, id, context),
    replay.get(id),
  )
}

function receipt(answer: AssistantMessage): ResponseReceipt {
  return {
    provider: answer.provider,
    model: answer.model,
    usage: copyJson(answer.usage, {
      omitUndefinedProperties: true,
    }) as ResponseReceipt['usage'],
    text: '',
    stopReason: answer.stopReason,
  }
}

async function nextRequestMessages(host: ExtensionHost, id: ConversationId, caller: Context) {
  const conversation = (await host.harness().conversation(id, caller))!
  let messages: Message[] = [...(await conversation.context(caller)).messages]
  const leadingConversationIdentity = conversationIdentity(id)
  if (
    !messages.some(
      (message) => message.role === 'user' && message.content === leadingConversationIdentity,
    )
  ) {
    const place = messages[0]?.role === 'system' ? 1 : 0
    messages = [
      ...messages.slice(0, place),
      { role: 'user', content: leadingConversationIdentity, timestamp: 0 },
      ...messages.slice(place),
    ]
  }
  return { messages, agent: await conversation.agent(caller) }
}

type Prepared =
  | { kind: 'replay'; model: Model<Api>; payload: unknown }
  | {
      kind: 'transcript'
      model: Model<Api>
      messages: Message[]
      reasoning?: ThinkingLevel
    }

async function sendPing(
  host: ExtensionHost,
  prepared: Prepared,
  at: number,
  signal: AbortSignal,
): Promise<{ ping?: Ping; answer?: AssistantMessage }> {
  const attempt = {
    at,
    provider: prepared.model.provider,
    model: prepared.model.id,
  }
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(PING_TIMEOUT_MS)])
  try {
    if (!open(host)) return {}
    const answer =
      prepared.kind === 'replay'
        ? await host.modelRuntime
            .streamSimple(
              prepared.model,
              { messages: [] },
              {
                ...getCacheWarmingRequestOptions({}, timeout),
                onPayload: () => prepared.payload,
              },
            )
            .result()
        : await host.modelRuntime
            .streamSimple(
              prepared.model,
              {
                messages: [
                  ...prepared.messages,
                  { role: 'user', content: PING_QUESTION, timestamp: at },
                ],
              },
              {
                ...(prepared.reasoning ? { reasoning: prepared.reasoning } : {}),
                maxRetries: 0,
                signal: timeout,
              },
            )
            .result()
    if (answer.stopReason === 'error' || answer.stopReason === 'aborted')
      return {
        ping: { ...attempt, error: answer.errorMessage ?? answer.stopReason },
        answer,
      }
    return {
      ping: {
        ...attempt,
        read: answer.usage.cacheRead,
        write: answer.usage.cacheWrite,
      },
      answer,
    }
  } catch (error) {
    return {
      ping: {
        ...attempt,
        error: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

const open = (host: ExtensionHost) => !host.want(PauseApi)?.paused()

type Checkpoint = { phase: 'plan' } | { phase: 'attempted' }

const stopped: NextTaskState<Checkpoint, null> = {
  status: 'terminal',
  outcome: { status: 'completed', result: null },
}

function pinger(host: ExtensionHost, replay: Replay) {
  return defineTask<null, Checkpoint, null>({
    name: 'keep-warm.ping',
    version: 1,
    initial: () => ({ phase: 'plan' }),
    phases: {
      plan: async (task, runtime, ctx) => {
        const id = task.conversationId
        const planned = await planFor(host, replay, id, runtime.now(), await discover(host))
        const due = !('stop' in planned) && planned.situation.now >= planned.nextAt
        const pingDue = due && planned.step === 'ping'
        const prepared: Prepared | undefined = !pingDue
          ? undefined
          : planned.situation.runActive
            ? planned.replay && {
                kind: 'replay',
                model: planned.model,
                payload: planned.replay.payload,
              }
            : await nextRequestMessages(host, id, ctx).then(({ messages, agent }) => ({
                kind: 'transcript' as const,
                model: planned.model,
                messages,
                ...(agent.thinkingLevel && agent.thinkingLevel !== 'off'
                  ? { reasoning: agent.thinkingLevel }
                  : {}),
              }))
        let sending: number | undefined
        let previous: Ping | undefined
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(State, id)
          if (doc.waker !== task.id) return stopped
          const again: NextTaskState<Checkpoint, null> = {
            status: 'sleeping',
            until: runtime.now(),
            checkpoint: { phase: 'plan' },
          }
          const current = renewalKey(doc, await tx.doc(AgentDoc, id), replay.get(id))
          if (current !== planned.renewal) return again
          const end = () => {
            delete doc.waker
            return stopped
          }
          if ('stop' in planned) return end()
          if (!due && typeof planned.dueStep !== 'string') return end()
          if (!due)
            return {
              status: 'sleeping',
              until: planned.nextAt,
              checkpoint: { phase: 'plan' },
            }
          if (typeof planned.step !== 'string') return end()
          if (planned.step === 'compact') {
            if (!(await tx.doc(LiveDoc, id)).run && !(await compacting(tx, id))) {
              const created = await admitCompaction(tx, id)
              doc.compaction = {
                at: runtime.now(),
                task: created,
                tokens: planned.situation.tokens,
              }
            }
            return end()
          }
          if (!open(host)) return again
          if (runtime.now() > lateRefreshCutoff(planned.situation)) return end()
          const run = (await tx.doc(LiveDoc, id)).run
          if (Boolean(run) !== planned.situation.runActive) return again
          if (!prepared) {
            if (run)
              return {
                status: 'waiting',
                on: [run.taskId],
                policy: 'any',
                checkpoint: { phase: 'plan' },
              }
            return again
          }
          sending = runtime.now()
          previous = doc.last && { ...doc.last }
          doc.last = {
            at: sending,
            provider: planned.model.provider,
            model: planned.model.id,
            error: 'interrupted',
          }
          doc.pings = (doc.pings ?? 0) + 1
          return { status: 'running', checkpoint: { phase: 'attempted' } }
        }, ctx)
        if (sending === undefined || !prepared || 'stop' in planned) return
        const { ping, answer } = await sendPing(host, prepared, sending, runtime.signal)
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(State, id)
          if (!ping) {
            if (previous) doc.last = previous
            else delete doc.last
            if (doc.pings && doc.pings > 1) doc.pings -= 1
            else delete doc.pings
            return { status: 'running', checkpoint: { phase: 'attempted' } }
          }
          doc.last = ping
          if (answer) {
            await host.need(ConversationsApi).accountResponse(tx, id, receipt(answer))
            if (ping.error === undefined)
              doc.streak = streakAfterPing(
                doc.streak,
                planned.situation.realRequestAt,
                answer.usage.cost.total,
              )
          }
          return { status: 'running', checkpoint: { phase: 'attempted' } }
        }, ctx)
      },
      attempted: (_task, runtime, ctx) =>
        runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'plan' } }), ctx),
    },
    abort: (task, runtime, ctx) =>
      runtime.commit(async (tx) => {
        const doc = await tx.doc(State, task.conversationId)
        if (doc.waker === task.id) delete doc.waker
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, ctx),
  })
}

const pingers = new WeakMap<ExtensionHost, ReturnType<typeof pinger>>()

async function arm(tx: Tx, host: ExtensionHost, id: ConversationId) {
  const doc = await tx.doc(State, id)
  const request = doc.request
  const model = request && host.modelRuntime.getModel(request.provider, request.model)
  const timing = model && cacheTiming(model)
  if (!timing || request.uncached) return
  const lastCacheRequestAt = Math.max(request.at, doc.last?.at ?? 0)
  if (Date.now() > lateRefreshCutoff({ ...timing, lastCacheRequestAt })) return
  const dueAt = lastCacheRequestAt + timing.delayBeforeRefresh
  const waker = doc.waker === undefined ? undefined : (await tx.task(doc.waker))?.state
  const sleepsPast = waker?.status === 'sleeping' && (waker.until ?? Infinity) > dueAt
  if (!waker || waker.status === 'terminal' || sleepsPast)
    doc.waker = await tx.createTask(pingers.get(host)!, null, {
      ownership: { kind: 'conversation' },
      conversationId: id,
      background: true,
    })
}

async function newestAnswer(host: ExtensionHost, id: ConversationId, after: number) {
  const conversation = (await host.harness().conversation(id, context))!
  let cursor: Cursor | undefined
  do {
    const page = await conversation.entries({}, 100, cursor, context)
    for (const entry of page.items) {
      if (entry.kind === 'pi.compaction' || entry.kind === 'pi.reset') return undefined
      const message = entry.model?.[0]
      if (!message) continue
      if (message.timestamp <= after) return undefined
      if (message.role !== 'assistant') continue
      return message.stopReason === 'error' || message.stopReason === 'aborted'
        ? undefined
        : message
    }
    cursor = page.next
  } while (cursor)
  return undefined
}

const requestOf = (
  answer: AssistantMessage,
  sentAt = answer.timestamp,
): NonNullable<WarmDocState['request']> => ({
  at: sentAt,
  provider: answer.provider,
  model: answer.model,
  ...(answer.usage.cacheRead + answer.usage.cacheWrite === 0 ? { uncached: true } : {}),
})

async function warmedConversations(host: ExtensionHost) {
  const records = await host.harness().commit(async (tx) => {
    const scanned = []
    let cursor: Cursor | undefined
    do {
      const page = await tx.scanConversations({}, 256, cursor)
      scanned.push(...page.items)
      cursor = page.next
    } while (cursor !== undefined)
    return scanned
  }, context)
  const ids: ConversationId[] = []
  for (const record of records) {
    if (record.owner) continue
    const label = (await host.harness().snapshot(host.metadata, record.id, context))?.label
    if (kindOf(false, label)) ids.push(record.id)
  }
  return ids
}

async function catchUp(host: ExtensionHost) {
  await host.harness().commit(async (tx) => {
    const root = await tx.doc(State, ROOT_CONVERSATION_ID)
    const ultimate = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
    if (!root.off || ultimate === undefined) return
    ;(await tx.doc(State, ultimate)).warm = false
    delete root.off
  }, context)
  const concluded = await host.need(ConversationsApi).concluded(context)
  for (const id of await warmedConversations(host)) {
    if (concluded.has(id)) continue
    const known = (await readDoc(host, id)).request?.at ?? 0
    const answer = await newestAnswer(host, id, Math.max(known, Date.now() - CLAUDE_CODE_TTL_MS))
    await host.harness().commit(async (tx) => {
      if (answer) (await tx.doc(State, id)).request = requestOf(answer)
      await arm(tx, host, id)
    }, context)
  }
}

const text = (message: AssistantMessage) =>
  message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim()

async function commitCompactionUsage(
  host: ExtensionHost,
  id: ConversationId,
  task: TaskId,
  outcome: Pick<Compaction, 'read' | 'write' | 'error'>,
  answer?: AssistantMessage,
) {
  await host.harness().commit(async (tx) => {
    const doc = await tx.doc(State, id)
    if (doc.compaction?.task === task) Object.assign(doc.compaction, outcome)
    if (answer) await host.need(ConversationsApi).accountResponse(tx, id, receipt(answer))
  }, context)
}

async function summaryFromCache(
  host: ExtensionHost,
  id: ConversationId,
  task: TaskId,
  keep: (summary: string) => Promise<string>,
) {
  const { messages, agent } = await nextRequestMessages(host, id, context)
  const model = agent.model && host.modelRuntime.getModel(agent.model.provider, agent.model.modelId)
  if (!model) return undefined
  messages.push({
    role: 'user',
    content: SUMMARY_REQUEST,
    timestamp: Date.now(),
  })
  let answer: AssistantMessage
  try {
    answer = await host.modelRuntime
      .streamSimple(
        model,
        { messages },
        {
          ...(agent.thinkingLevel === 'off' ? {} : { reasoning: agent.thinkingLevel }),
          signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
        },
      )
      .result()
  } catch (error) {
    await commitCompactionUsage(host, id, task, {
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
  const fresh = answer.stopReason === 'stop' ? text(answer) : ''
  const summary = fresh ? await keep(fresh) : undefined
  await commitCompactionUsage(
    host,
    id,
    task,
    summary
      ? { read: answer.usage.cacheRead, write: answer.usage.cacheWrite }
      : { error: answer.errorMessage ?? `no summary (${answer.stopReason})` },
    answer,
  )
  return summary
}

async function state(host: ExtensionHost, replay: Replay, id: ConversationId): Promise<WarmState> {
  const usage = await host.harness().snapshot(ContextUsageDoc, id, context)
  const agent = await agentOf(host, id)
  const model =
    agent?.model && host.modelRuntime.getModel(agent.model.provider, agent.model.modelId)
  const timing = model && cacheTiming(model)
  const definitions = await discover(host)
  const {
    kind,
    agent: definition,
    doc,
    resolved,
  } = await policyFor(host, id, timing?.ttl, definitions)
  const listed = kind && !(await host.need(ConversationsApi).concluded(context)).has(id)
  const base = {
    ...(listed ? { kind } : {}),
    ...(definition ? { agent: definition.name } : {}),
    warm: resolved.warm,
    compact: resolved.compact,
    minutes: resolved.minutes,
    compactTokens: resolved.compactTokens,
    tokens: usage?.tokens ?? 0,
    pings: doc.pings ?? 0,
    ...(doc.inputAt === undefined ? {} : { inputAt: doc.inputAt }),
    ...(doc.last ? { last: doc.last } : {}),
    ...(doc.compaction ? { compaction: doc.compaction } : {}),
  }
  if (!listed) return { ...base, idle: 'Not a standing agent or an open branch' }
  if (!model) return { ...base, idle: 'No model' }
  const reasoning = agent.thinkingLevel === 'off' ? undefined : agent.thinkingLevel
  const described: WarmState = {
    ...base,
    provider: model.provider,
    model: model.id,
    ...(timing ? { ttl: timing.ttl, pingAfter: timing.delayBeforeRefresh } : {}),
    replayable: isCacheWarmingReplayable(model, { reasoning }),
    ...(timing
      ? {
          rewriteCost: rewriteCost(model, timing.ttl, usage?.tokens ?? 0),
          warmCost: warmCost(
            model,
            timing.delayBeforeRefresh,
            resolved.minutes.value,
            usage?.tokens ?? 0,
          ),
        }
      : {}),
  }
  const planned = await planOf(host, replay, id, 'due', definitions)
  if ('stop' in planned) return { ...described, idle: planned.stop }
  const kept = keptBy(doc.streak, planned.situation.realRequestAt)
  const live = {
    ...described,
    ...(kept ? { kept } : {}),
    lastAt: planned.situation.lastCacheRequestAt,
    running: planned.situation.runActive,
    ...(planned.step === 'ping' && Number.isFinite(planned.warmUntil)
      ? { warmUntil: planned.warmUntil }
      : {}),
  }
  if (typeof planned.step !== 'string') return { ...live, idle: planned.step.stop }
  if (planned.step === 'ping' && !open(host)) return { ...live, idle: 'Ultimate is paused' }
  const waker = await wakerOf(host, doc)
  if (!waker) return { ...live, idle: 'Waiting for the next request' }
  if (waker.status === 'waiting') return { ...live, idle: 'Waiting for the run to end' }
  return { ...live, next: { at: planned.nextAt, step: planned.step } }
}

async function wakerOf(host: ExtensionHost, doc: WarmDocState) {
  if (doc.waker === undefined) return undefined
  const task = await host.harness().commit((tx) => tx.task(doc.waker!), context)
  return task && task.state.status !== 'terminal' ? task.state : undefined
}

const replayOf = (host: ExtensionHost) => host.resource<Replay>('keep-warm.replay', () => new Map())

export default function keepWarm(host: ExtensionHost) {
  host.need(ConversationsApi)
  host.want(PauseApi)
  const replay = replayOf(host)
  const Pinger = pinger(host, replay)
  pingers.set(host, Pinger)
  host.react(
    'user-input',
    [UserInputEvent],
    async (tx, { data, at }) => {
      const standing = Object.values(await tx.doc(Standing, ROOT_CONVERSATION_ID))
      if (!standing.includes(data.conversation)) return
      ;(await tx.doc(State, data.conversation)).inputAt = Date.parse(at)
    },
    { from: 'now' },
  )
  host.onOpen(async () => {
    rebuiltOnOpen(
      'catching up on answers that came while keep-warm was not watching runs again on each open',
      catchUp(host).catch((error: unknown) => host.notice(`Keep warm: ${String(error)}`)),
    )
  })
  return defineExtension({
    name: 'keep-warm',
    tasks: [Pinger],
    hooks: [
      hook(GenerationTask, {
        beforeProviderRequest: async ({ model, payload }, api, ctx) => {
          const now = Date.now()
          for (const [id, sent] of replay)
            if (now - sent.at > CACHE_WARMING_MAX_AGE_MS) replay.delete(id)
          const thinking = (await api.snapshot(AgentDoc, api.conversationId, ctx))?.thinkingLevel
          const reasoning = thinking === undefined || thinking === 'off' ? undefined : thinking
          const capped = isCacheWarmingReplayable(model, { reasoning })
            ? oneTokenPayload(model.api, payload)
            : undefined
          replay.set(api.conversationId, { model, at: now, ...(capped ? { payload: capped } : {}) })
          return undefined
        },
        afterResponse: async (message, api, ctx) => {
          const sent = replay.get(api.conversationId)
          if (message.stopReason === 'error' || message.stopReason === 'aborted') {
            replay.delete(api.conversationId)
            return
          }
          if (!(await warmedKind(host, api.conversationId))) {
            replay.delete(api.conversationId)
            return
          }
          await host.harness().commit(async (tx) => {
            ;(await tx.doc(State, api.conversationId)).request = requestOf(message, sent?.at)
            await arm(tx, host, api.conversationId)
          }, ctx)
        },
      }),
      hook(CompactionTask, {
        beforeCompact: async (_compaction, api, ctx) => {
          replay.delete(api.conversationId)
          const doc = await api.snapshot(State, api.conversationId, ctx)
          if (doc?.compaction?.task !== api.taskId) return undefined
          const kept = await api.memo<string>('keep-warm.summary', ctx)
          if (kept !== undefined) return { summary: kept }
          if ((await api.snapshot(LiveDoc, api.conversationId, ctx))?.run) return undefined
          const summary = await summaryFromCache(host, api.conversationId, api.taskId, (fresh) =>
            api.memo('keep-warm.summary', fresh, ctx),
          )
          return summary === undefined ? undefined : { summary }
        },
      }),
    ],
  })
}

function conversationArg(args: unknown) {
  const id = (args as { id?: unknown } | null)?.id
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)
    throw new Error('Expected { id: conversation }')
  return parseConversationId(id)
}

function override<T>(value: unknown, valid: (value: unknown) => value is T, message: string) {
  if (value === undefined || value === null || valid(value)) return value as T | null | undefined
  throw new Error(message)
}

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

export const actions = {
  state: implementAction(StateAction, (args, { host }) =>
    state(host, replayOf(host), conversationArg(args)),
  ),
  set: implementAction(SetAction, async (args, action) => {
    const { host } = action
    const id = conversationArg(args)
    const values = args as {
      warm?: unknown
      compact?: unknown
      minutes?: unknown
    }
    const change = {
      warm: override(values.warm, isBoolean, 'warm must be a boolean or null'),
      compact: override(values.compact, isBoolean, 'compact must be a boolean or null'),
      minutes: override(values.minutes, isCount, 'minutes must be a number of at least 0, or null'),
    }
    const kind = await warmedKind(host, id)
    if (!kind || (await host.need(ConversationsApi).concluded(context)).has(id))
      throw new Error(`#${id} is not a standing agent or an open branch`)
    if (kind === 'standing' && change.compact)
      throw new Error('Standing agents are not compacted before cold: their dreams handle it')
    await host.harness().commit(async (tx) => {
      const doc = await tx.doc(State, id)
      for (const key of ['warm', 'compact', 'minutes'] as const) {
        const value = change[key]
        if (value === undefined || value === doc[key]) continue
        await action.uiChanged(tx, {
          key: `keep-warm.${key}`,
          ...(value === null ? {} : { value }),
          ...(doc[key] === undefined ? {} : { previous: doc[key] }),
        })
        if (value === null) delete doc[key]
        else Object.assign(doc, { [key]: value })
      }
      await arm(tx, host, id)
    }, context)
    return state(host, replayOf(host), id)
  }),
}
export const userActions = ['set']
