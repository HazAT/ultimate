/**
 * Keep warm: Claude Code, or the Anthropic API under `PI_CACHE_RETENTION=long`, caches @ultimate's prompt for an hour
 * after each request. Shortly before that hour ends, with @ultimate idle and the user away less than 8 hours, one
 * request replays @ultimate's context as its next request would send it, plus a one-word question. It reads the whole
 * prefix from the cache, which renews the hour, and leaves nothing in any transcript; its tokens count toward
 * @ultimate's usage.
 */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { copyJson } from '@earendil-works/chord/json'
import {
  defineDoc,
  defineExtension,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, ModelRef } from '@earendil-works/pi-durable'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { ExtensionHost } from '../../server/extensions.ts'
import { UserInputEvent } from '../../shared/events.ts'
import { implementAction } from '../../lib/actions.ts'
import type { ResponseReceipt } from '../conversations/summary.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { PauseApi } from '../pause/api.ts'
import { Standing } from '../subagents/api.ts'
import { due, LEAD, TTL } from './due.ts'
import { SetAction, StateAction, WarmDoc } from './refs.ts'
import type { Ping, WarmDocState, WarmState } from './refs.ts'

const State = defineDoc<WarmDocState>({
  kind: WarmDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
export const docs = [State]

/** How often the timer looks; a ping lands within a minute after `LEAD`, well inside the hour. */
const TICK = 60_000
/** Caches for an hour (`ttl: "1h"`): Claude Code always, the Anthropic API under `PI_CACHE_RETENTION=long`. */
export const hourLong = (provider: string) =>
  provider === 'claude-code' ||
  (provider === 'anthropic' && process.env.PI_CACHE_RETENTION === 'long')
const QUESTION = 'Cache keep-warm check from Ultimate, not from the user. Reply with just: ok'

const read = async (host: ExtensionHost) =>
  (await host.harness().snapshot(State, ROOT_CONVERSATION_ID, context)) ?? {}

const ultimateOf = async (host: ExtensionHost) =>
  (await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate

/** The last ping, if it was on `model`: the same model id on another provider has another cache. */
export const lastOn = (last: Ping | undefined, model: ModelRef) =>
  last?.provider === model.provider && last.model === model.modelId ? last : undefined

/** A response that read or wrote `model`'s cache: an answer that came back, with cache tokens. */
export const cached = (message: AssistantMessage, model: ModelRef) =>
  message.provider === model.provider &&
  message.model === model.modelId &&
  message.stopReason !== 'error' &&
  message.stopReason !== 'aborted' &&
  message.usage.cacheRead + message.usage.cacheWrite > 0

/**
 * When @ultimate's own requests last renewed `model`'s cache (ms): its newest such response within the hour. A failed
 * response or one of another model renews nothing, so it does not count.
 */
async function answeredAt(host: ExtensionHost, id: ConversationId, model: ModelRef, now: number) {
  const conversation = (await host.harness().conversation(id, context))!
  let cursor: Cursor | undefined
  do {
    const page = await conversation.entries({}, 100, cursor, context)
    for (const entry of page.items) {
      const message = entry.model?.[0]
      if (message?.role !== 'assistant') continue
      if (now - message.timestamp >= TTL) return undefined
      if (cached(message, model)) return message.timestamp
    }
    cursor = page.next
  } while (cursor)
  return undefined
}

/**
 * Whether Ultimate is paused for a cause a ping must not run into: the user's Pause, whose "nothing new starts" covers
 * pings too, or a rate limit, which would fail it. A hold with an end (a usage window at its soft cap) still lets pings
 * through: the provider answers, and the work it holds resumes on this cache.
 */
export function stopped(pause: { paused(): boolean; heldSince(): number | undefined } | undefined) {
  return !!pause?.paused() && pause.heldSince() === undefined
}

/** @ultimate, its model and the times that decide a ping; undefined while its provider does not cache for an hour. */
async function activity(host: ExtensionHost, doc: WarmDocState, now: number) {
  const id = await ultimateOf(host)
  const conversation = id === undefined ? undefined : await host.harness().conversation(id, context)
  if (!conversation) return undefined
  const model = (await conversation.agent(context)).model
  if (!model || !hourLong(model.provider)) return undefined
  const answered = await answeredAt(host, id!, model, now)
  const last = lastOn(doc.last, model)
  const pinged = last && !last.error ? last.at : undefined
  const lastRequest = Math.max(answered ?? 0, pinged ?? 0) || undefined
  return {
    id: id!,
    provider: model.provider,
    model: model.modelId,
    lastRequest,
    failedAfter: last?.error ? last.at : undefined,
    inputAt: doc.inputAt,
    heldSince: host.want(PauseApi)?.heldSince(),
  }
}

/** Not `stopped` and the cache still within its hour; synchronous, so nothing slips in after it. */
export const open = (paused: boolean, lastRequest: number, now: number) =>
  !paused && now - lastRequest < TTL

/**
 * In one commit: record the attempt as interrupted, only while it is still on, @ultimate has no run and no other
 * attempt was recorded since the tick read `previous`. A crash mid-request then counts as a failure, never a retry.
 */
async function claim(host: ExtensionHost, id: ConversationId, attempt: Ping, previous?: number) {
  return host.harness().commit(async (tx) => {
    const doc = await tx.doc(State, ROOT_CONVERSATION_ID)
    if (doc.off || doc.last?.at !== previous || (await tx.doc(LiveDoc, id)).run) return false
    doc.last = attempt
    doc.pings = (doc.pings ?? 0) + 1
    return true
  }, context)
}

/** Store the attempt's outcome, with the response's usage on @ultimate when there is one, in one commit. */
async function record(
  host: ExtensionHost,
  id: ConversationId,
  last: Ping,
  answer?: AssistantMessage,
) {
  await host.harness().commit(async (tx) => {
    ;(await tx.doc(State, ROOT_CONVERSATION_ID)).last = last
    if (answer)
      await host.need(ConversationsApi).accountResponse(tx, id, {
        provider: answer.provider,
        model: answer.model,
        usage: copyJson(answer.usage, {
          omitUndefinedProperties: true,
        }) as ResponseReceipt['usage'],
        text: '',
        stopReason: answer.stopReason,
      })
  }, context)
}

/**
 * One request with @ultimate's next context and the question, unless something changed while it was prepared. It is
 * recorded as interrupted before it is sent, so a crash never leads to a second try.
 */
async function ping(
  host: ExtensionHost,
  found: {
    id: ConversationId
    provider: string
    model: string
    lastRequest: number
    previous?: number
  },
) {
  const paused = () => stopped(host.want(PauseApi))
  const { id, provider } = found
  const conversation = (await host.harness().conversation(id, context))!
  const agent = await conversation.agent(context)
  const model = host.modelRuntime.getModel(provider, found.model)
  if (!model) return
  let messages: Message[] = [...(await conversation.context(context)).messages]
  // As conversations' beforeRequest hook sends it (extensions/conversations/server.ts): the identity leads, once.
  const identity = `You are conversation #${id}.`
  if (!messages.some((message) => message.role === 'user' && message.content === identity))
    messages = [{ role: 'user', content: identity, timestamp: 0 }, ...messages]
  const at = Date.now()
  messages.push({ role: 'user', content: QUESTION, timestamp: at })
  // Preparing awaited: a pause, a new run or the switch may have come in meanwhile. The claim checks the switch and the
  // run in its commit; pause and the hour are checked again after it, with nothing awaited before the request starts.
  if (!open(paused(), found.lastRequest, Date.now())) return
  if (
    !(await claim(
      host,
      id,
      { at, provider, model: found.model, error: 'interrupted' },
      found.previous,
    ))
  )
    return
  if (!open(paused(), found.lastRequest, Date.now())) {
    await record(host, id, {
      at,
      provider,
      model: found.model,
      error: 'skipped: paused or expired',
    })
    return
  }
  let answer: AssistantMessage
  try {
    // No sessionId: a one-shot Claude Code process, so @ultimate's own warm process never sees this turn.
    answer = await host.modelRuntime
      .streamSimple(
        model,
        { messages },
        {
          ...(agent.thinkingLevel === 'off' ? {} : { reasoning: agent.thinkingLevel }),
          signal: AbortSignal.timeout(180_000),
        },
      )
      .result()
  } catch (error) {
    // Kept as the last ping: it blocks pings until @ultimate's next request, so a failure is never retried.
    await record(host, id, {
      at,
      provider,
      model: found.model,
      error: error instanceof Error ? error.message : String(error),
    })
    return
  }
  const failed = answer.stopReason === 'error' || answer.stopReason === 'aborted'
  await record(
    host,
    id,
    failed
      ? { at, provider, model: found.model, error: answer.errorMessage ?? answer.stopReason }
      : {
          at,
          provider,
          model: found.model,
          read: answer.usage.cacheRead,
          write: answer.usage.cacheWrite,
        },
    answer,
  )
}

async function tick(host: ExtensionHost) {
  if (stopped(host.want(PauseApi))) return
  const doc = await read(host)
  if (doc.off) return
  const now = Date.now()
  const found = await activity(host, doc, now)
  if (!found?.lastRequest || !due({ now, ...found })) return
  await ping(host, { ...found, lastRequest: found.lastRequest, previous: doc.last?.at })
}

async function state(host: ExtensionHost): Promise<WarmState> {
  const doc = await read(host)
  const now = Date.now()
  const found = await activity(host, doc, now)
  const on = !doc.off
  const base = {
    on,
    pings: doc.pings ?? 0,
    ...(doc.last ? { last: doc.last } : {}),
    ...(doc.inputAt === undefined ? {} : { inputAt: doc.inputAt }),
  }
  if (!found) return base
  const nextAt = found.lastRequest === undefined ? undefined : found.lastRequest + LEAD
  const will = on && nextAt !== undefined && due({ ...found, now: Math.max(now, nextAt) })
  return {
    ...base,
    ...(found.lastRequest === undefined ? {} : { lastRequest: found.lastRequest }),
    ...(will ? { nextAt } : {}),
  }
}

export default function keepWarm(host: ExtensionHost) {
  // Resolved where they are called; declared here so the catalogue lists them.
  host.need(ConversationsApi)
  host.want(PauseApi)
  // The user's latest input to @ultimate: typed, or an answer to its question.
  host.react(
    'user-input',
    [UserInputEvent],
    async (tx, { data, at }) => {
      if ((await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate !== data.conversation) return
      ;(await tx.doc(State, ROOT_CONVERSATION_ID)).inputAt = Date.parse(at)
    },
    { from: 'now' },
  )
  const shared = host.resource('keep-warm.timer', () => ({
    running: undefined as Promise<void> | undefined,
  }))
  const timer = setInterval(() => {
    shared.running ??= tick(host)
      .catch((error: unknown) => host.notice(`Keep warm: ${String(error)}`))
      .finally(() => {
        shared.running = undefined
      })
  }, TICK)
  host.onClose(async () => {
    clearInterval(timer)
    await shared.running
  })
  return defineExtension({ name: 'keep-warm' })
}

export const actions = {
  state: implementAction(StateAction, (_args, { host }) => state(host)),
  set: implementAction(SetAction, async (args, { host }) => {
    const on = (args as { on?: unknown } | null)?.on
    if (typeof on !== 'boolean') throw new Error('Expected { on: boolean }')
    await host.harness().commit(async (tx) => {
      const doc = await tx.doc(State, ROOT_CONVERSATION_ID)
      if (on) delete doc.off
      else doc.off = true
    }, context)
    return state(host)
  }),
}
/** Pings spend the user's plan; only they turn them on or off. */
export const userActions = ['set']
