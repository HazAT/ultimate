import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord/context'
import { copyJson } from '@earendil-works/chord/json'
import {
  AgentDoc,
  defineDoc,
  defineExtension,
  defineTask,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type {
  ConversationId,
  Cursor,
  ModelRef,
  NextTaskState,
  Tx,
} from '@earendil-works/pi-durable'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { ExtensionHost } from '../../server/extensions.ts'
import { UserInputEvent } from '../../shared/events.ts'
import { implementAction } from '../../lib/actions.ts'
import { conversationIdentity } from '../../lib/ids.shared.ts'
import { onCommit } from '../../lib/commits.ts'
import { rebuiltOnOpen } from '../../lib/errors.shared.ts'
import type { ResponseReceipt } from '../conversations/summary.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { PauseApi } from '../pause/api.ts'
import { Standing } from '../subagents/api.ts'
import { due, LEAD, TTL } from './due.shared.ts'
import { SetAction, StateAction, WarmDoc } from './refs.ts'
import type { Ping, WarmDocState, WarmState } from './refs.ts'
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

export const hourLong = (provider: string) =>
  provider === 'claude-code' ||
  (provider === 'anthropic' && process.env.PI_CACHE_RETENTION === 'long')
const QUESTION = 'Cache keep-warm check from Ultimate, not from the user. Reply with just: ok'

export const lastOn = <R extends { provider: string; model: string }>(
  last: R | undefined,
  model: ModelRef,
) => (last?.provider === model.provider && last.model === model.modelId ? last : undefined)

export const cached = (message: AssistantMessage) =>
  hourLong(message.provider) &&
  message.stopReason !== 'error' &&
  message.stopReason !== 'aborted' &&
  message.usage.cacheRead + message.usage.cacheWrite > 0

const key = (id: ConversationId, model: ModelRef) => `${id}:${model.provider}/${model.modelId}`

export function plan(
  doc: WarmDocState,
  id: ConversationId | undefined,
  model: ModelRef | undefined,
  now: number,
) {
  if (id === undefined || !model || !hourLong(model.provider)) return undefined
  const ping = lastOn(doc.last, model)
  const last = ping && (ping.conversation ?? id) === id ? ping : undefined
  const lastRequest = Math.max(
    doc.answers?.[key(id, model)] ?? 0,
    last && !last.error ? last.at : 0,
  )
  if (!lastRequest) return undefined
  const at = lastRequest + LEAD
  const found = {
    lastRequest,
    failedAfter: last?.error ? last.at : undefined,
    inputAt: doc.inputAt,
  }
  return {
    provider: model.provider,
    model: model.modelId,
    lastRequest,
    at,
    due: !doc.off && due({ ...found, now: Math.max(now, at) }),
  }
}

export const open = (paused: boolean | undefined, lastRequest: number, now: number) =>
  !paused && now - lastRequest < TTL

const owner = {
  ownership: { kind: 'conversation' as const },
  conversationId: ROOT_CONVERSATION_ID,
  background: true,
}
const stop = {
  status: 'terminal' as const,
  outcome: { status: 'completed' as const, result: null },
}

async function ultimate(host: ExtensionHost, caller: Context) {
  const id = (await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, caller))?.ultimate
  const conversation = id === undefined ? undefined : await host.harness().conversation(id, caller)
  return (
    conversation && {
      id: id!,
      agent: await conversation.agent(caller),
      conversation,
    }
  )
}

async function pingRequest(
  conversation: {
    context: (c: Context) => Promise<{ messages: readonly Message[] }>
  },
  id: ConversationId,
  caller: Context,
) {
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
  return messages
}

type Planned = NonNullable<ReturnType<typeof plan>>

async function send(
  host: ExtensionHost,
  found: NonNullable<Awaited<ReturnType<typeof ultimate>>>,
  messages: Message[],
  next: Planned,
  at: number,
  runtime: { now(): number; signal: AbortSignal },
): Promise<{ last: Ping; answer?: AssistantMessage }> {
  const attempt = { at, provider: next.provider, model: next.model }
  const model = host.modelRuntime.getModel(next.provider, next.model)
  if (!model)
    return {
      last: {
        ...attempt,
        error: `unknown model ${next.provider}/${next.model}`,
      },
    }
  try {
    if (!open(host.want(PauseApi)?.paused(), next.lastRequest, runtime.now()))
      return { last: { ...attempt, error: 'skipped: paused or expired' } }
    const thinking = found.agent.thinkingLevel
    const answer = await host.modelRuntime
      .streamSimple(
        model,
        { messages },
        {
          ...(thinking === 'off' ? {} : { reasoning: thinking }),
          signal: AbortSignal.any([AbortSignal.timeout(180_000), runtime.signal]),
        },
      )
      .result()
    if (answer.stopReason === 'error' || answer.stopReason === 'aborted')
      return {
        last: { ...attempt, error: answer.errorMessage ?? answer.stopReason },
        answer,
      }
    return {
      last: {
        ...attempt,
        read: answer.usage.cacheRead,
        write: answer.usage.cacheWrite,
      },
      answer,
    }
  } catch (error) {
    return {
      last: {
        ...attempt,
        error: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

const MODEL_RETRY_MS = 60_000

type Checkpoint = { phase: 'plan' } | { phase: 'attempted' }

function pinger(host: ExtensionHost) {
  const sleepOrStop = (
    doc: WarmDocState,
    next: Planned | undefined,
    now: number,
  ): NextTaskState<Checkpoint, null> => {
    if (next?.due && next.at > now)
      return {
        status: 'sleeping',
        until: next.at,
        checkpoint: { phase: 'plan' },
      }
    delete doc.waker
    return stop
  }
  return defineTask<null, Checkpoint, null>({
    name: 'keep-warm.ping',
    version: 1,
    initial: () => ({ phase: 'plan' }),
    phases: {
      plan: async (task, runtime, ctx) => {
        const found = await ultimate(host, ctx)
        const ready =
          found &&
          plan(
            (await runtime.snapshot(State, ROOT_CONVERSATION_ID, ctx)) ?? {},
            found.id,
            found.agent.model,
            runtime.now(),
          )
        const messages =
          ready?.due && ready.at <= runtime.now()
            ? await pingRequest(found!.conversation, found!.id, ctx)
            : undefined
        let sending: { next: Planned; at: number } | undefined
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(State, ROOT_CONVERSATION_ID)
          if (doc.waker !== task.id) return stop
          const now = runtime.now()
          const id = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
          const model = id === undefined ? undefined : (await tx.doc(AgentDoc, id)).model
          if (id !== undefined && model) await recordRenewal(tx, doc, id, model)
          const next = plan(doc, id, model, now)
          if (!next?.due || next.at > now) return sleepOrStop(doc, next, now)
          const prepared = !!messages && id === found!.id && !!lastOn(next, found!.agent.model!)
          if (!prepared || host.want(PauseApi)?.paused())
            return { status: 'sleeping', until: now, checkpoint: { phase: 'plan' } }
          if (!host.modelRuntime.getModel(next.provider, next.model))
            return {
              status: 'sleeping',
              until: Math.min(now + MODEL_RETRY_MS, next.lastRequest + TTL),
              checkpoint: { phase: 'plan' },
            }
          const run = (await tx.doc(LiveDoc, found!.id)).run
          if (run)
            return {
              status: 'waiting',
              on: [run.taskId],
              policy: 'any',
              checkpoint: { phase: 'plan' },
            }
          doc.last = {
            at: now,
            conversation: id,
            provider: next.provider,
            model: next.model,
            error: 'interrupted',
          }
          doc.pings = (doc.pings ?? 0) + 1
          sending = { next, at: now }
          return { status: 'running', checkpoint: { phase: 'attempted' } }
        }, ctx)
        if (!sending) return
        messages!.push({ role: 'user', content: QUESTION, timestamp: sending.at })
        const { last, answer } = await send(
          host,
          found!,
          messages!,
          sending.next,
          sending.at,
          runtime,
        )
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(State, ROOT_CONVERSATION_ID)
          doc.last = { ...last, conversation: found!.id }
          if (answer)
            await host.need(ConversationsApi).accountResponse(tx, found!.id, {
              provider: answer.provider,
              model: answer.model,
              usage: copyJson(answer.usage, {
                omitUndefinedProperties: true,
              }) as ResponseReceipt['usage'],
              text: '',
              stopReason: answer.stopReason,
            })
          return { status: 'running', checkpoint: { phase: 'attempted' } }
        }, ctx)
      },
      attempted: (_task, runtime, ctx) =>
        runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'plan' } }), ctx),
    },
    abort: (task, runtime, ctx) =>
      runtime.commit(async (tx) => {
        const doc = await tx.doc(State, ROOT_CONVERSATION_ID)
        if (doc.waker === task.id) delete doc.waker
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, ctx),
  })
}

async function newestCachedAnswer(tx: Tx, id: ConversationId, model: ModelRef, since: number) {
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanEntries({ conversationId: id }, 100, cursor)
    for (const entry of page.items) {
      const message = entry.model?.[0]
      if (message?.role !== 'assistant') continue
      if (message.timestamp <= since) return undefined
      if (cached(message) && lastOn(message, model)) return message.timestamp
    }
    cursor = page.next
  } while (cursor)
  return undefined
}

async function arm(tx: Tx, host: ExtensionHost) {
  const Pinger = pingers.get(host)!
  const doc = await tx.doc(State, ROOT_CONVERSATION_ID)
  const id = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
  const next =
    id === undefined ? undefined : plan(doc, id, (await tx.doc(AgentDoc, id)).model, Date.now())
  if (!next?.due) return
  const waker = doc.waker === undefined ? undefined : (await tx.task(doc.waker))?.state
  const sleepsPast = waker?.status === 'sleeping' && (waker.until ?? Infinity) > next.at
  if (!waker || waker.status === 'terminal' || sleepsPast)
    doc.waker = await tx.createTask(Pinger, null, owner)
}

async function recordRenewal(tx: Tx, doc: WarmDocState, id: ConversationId, model: ModelRef) {
  if (!hourLong(model.provider)) return
  const known = doc.answers?.[key(id, model)] ?? 0
  const newest = await newestCachedAnswer(tx, id, model, Math.max(known, Date.now() - TTL))
  if (newest !== undefined) doc.answers = { ...doc.answers, [key(id, model)]: newest }
}

async function catchUp(host: ExtensionHost, changed?: Set<ConversationId>) {
  const found = await ultimate(host, context)
  if (changed && !(found && changed.has(found.id))) return
  await host.harness().commit(async (tx) => {
    const id = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
    const model = id === undefined ? undefined : (await tx.doc(AgentDoc, id)).model
    if (id !== undefined && model)
      await recordRenewal(tx, await tx.doc(State, ROOT_CONVERSATION_ID), id, model)
    await arm(tx, host)
  }, context)
}

async function state(host: ExtensionHost): Promise<WarmState> {
  const doc = (await host.harness().snapshot(State, ROOT_CONVERSATION_ID, context)) ?? {}
  const found = await ultimate(host, context)
  const next = plan(doc, found?.id, found?.agent.model, Date.now())
  return {
    on: !doc.off,
    pings: doc.pings ?? 0,
    ...(doc.last ? { last: doc.last } : {}),
    ...(doc.inputAt === undefined ? {} : { inputAt: doc.inputAt }),
    ...(next ? { lastRequest: next.lastRequest } : {}),
    ...(next?.due ? { nextAt: next.at } : {}),
  }
}

const pingers = new WeakMap<ExtensionHost, ReturnType<typeof pinger>>()

export default function keepWarm(host: ExtensionHost) {
  const Pinger = pinger(host)
  pingers.set(host, Pinger)
  host.need(ConversationsApi)
  host.want(PauseApi)
  host.react(
    'user-input',
    [UserInputEvent],
    async (tx, { data, at }) => {
      if ((await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate !== data.conversation) return
      ;(await tx.doc(State, ROOT_CONVERSATION_ID)).inputAt = Date.parse(at)
      await arm(tx, host)
    },
    { from: 'now' },
  )
  host.onOpen(async (opened) => {
    const stopWatching = onCommit(host.harness(), (publication) => {
      const changed = new Set<ConversationId>()
      for (const change of publication.changes) {
        if (
          change.type === 'document' &&
          change.record.kind === AgentDoc.definition.kind &&
          change.conversationId !== undefined
        )
          changed.add(change.conversationId)
        const message = change.type === 'entry' ? change.value.model?.[0] : undefined
        if (change.type === 'entry' && message?.role === 'assistant' && cached(message))
          changed.add(change.value.conversationId)
      }
      if (changed.size) rebuiltOnOpen('open catches up again', catchUp(host, changed))
    })
    opened.defer(stopWatching)
    await catchUp(host)
  })
  return defineExtension({
    name: 'keep-warm',
    tasks: [Pinger],
  })
}

export const actions = {
  state: implementAction(StateAction, (_args, { host }) => state(host)),
  set: implementAction(SetAction, async (args, action) => {
    const { host } = action
    const on = (args as { on?: unknown } | null)?.on
    if (typeof on !== 'boolean') throw new Error('Expected { on: boolean }')
    await host.harness().commit(async (tx) => {
      const doc = await tx.doc(State, ROOT_CONVERSATION_ID)
      if (on === !doc.off) return
      if (on) delete doc.off
      else doc.off = true
      await arm(tx, host)
      await action.uiChanged(tx, {
        key: 'keep-warm.on',
        value: on,
        previous: !on,
      })
    }, context)
    return state(host)
  }),
}
export const userActions = ['set']
