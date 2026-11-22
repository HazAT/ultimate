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
import { conversationIdentity } from '../../lib/ids.ts'
import { every } from '../../lib/timers.ts'
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

const CACHE_CHECK_INTERVAL_MS = 60_000
export const hourLong = (provider: string) =>
  provider === 'claude-code' ||
  (provider === 'anthropic' && process.env.PI_CACHE_RETENTION === 'long')
const QUESTION = 'Cache keep-warm check from Ultimate, not from the user. Reply with just: ok'

const read = async (host: ExtensionHost) =>
  (await host.harness().snapshot(State, ROOT_CONVERSATION_ID, context)) ?? {}

const ultimateOf = async (host: ExtensionHost) =>
  (await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate

export const lastOn = (last: Ping | undefined, model: ModelRef) =>
  last?.provider === model.provider && last.model === model.modelId ? last : undefined

export const cached = (message: AssistantMessage, model: ModelRef) =>
  message.provider === model.provider &&
  message.model === model.modelId &&
  message.stopReason !== 'error' &&
  message.stopReason !== 'aborted' &&
  message.usage.cacheRead + message.usage.cacheWrite > 0

async function lastCacheRenewingAnswerAtMs(
  host: ExtensionHost,
  id: ConversationId,
  model: ModelRef,
  now: number,
) {
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

async function activity(host: ExtensionHost, doc: WarmDocState, now: number) {
  const id = await ultimateOf(host)
  const conversation = id === undefined ? undefined : await host.harness().conversation(id, context)
  if (!conversation) return undefined
  const model = (await conversation.agent(context)).model
  if (!model || !hourLong(model.provider)) return undefined
  const answered = await lastCacheRenewingAnswerAtMs(host, id!, model, now)
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
  }
}

export const open = (paused: boolean | undefined, lastRequest: number, now: number) =>
  !paused && now - lastRequest < TTL

async function commitIdleUnchangedAttempt(
  host: ExtensionHost,
  id: ConversationId,
  attempt: Ping,
  previous?: number,
) {
  return host.harness().commit(async (tx) => {
    const doc = await tx.doc(State, ROOT_CONVERSATION_ID)
    if (doc.off || doc.last?.at !== previous || (await tx.doc(LiveDoc, id)).run) return false
    doc.last = attempt
    doc.pings = (doc.pings ?? 0) + 1
    return true
  }, context)
}

async function commitPingOutcomeAndUsage(
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

async function sendOneShotPingWithoutSession(
  host: ExtensionHost,
  found: {
    id: ConversationId
    provider: string
    model: string
    lastRequest: number
    previous?: number
  },
  signal: AbortSignal,
) {
  const paused = () => host.want(PauseApi)?.paused()
  const { id, provider } = found
  const conversation = (await host.harness().conversation(id, context))!
  const agent = await conversation.agent(context)
  const model = host.modelRuntime.getModel(provider, found.model)
  if (!model) return
  let messages: Message[] = [...(await conversation.context(context)).messages]
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
  const at = Date.now()
  messages.push({ role: 'user', content: QUESTION, timestamp: at })
  if (!open(paused(), found.lastRequest, Date.now())) return
  if (
    !(await commitIdleUnchangedAttempt(
      host,
      id,
      { at, provider, model: found.model, error: 'interrupted' },
      found.previous,
    ))
  )
    return
  const startPingIfCacheOpen = ():
    | { answer: Promise<AssistantMessage> }
    | { error: unknown }
    | undefined => {
    if (!open(paused(), found.lastRequest, Date.now())) return undefined
    try {
      return {
        answer: host.modelRuntime
          .streamSimple(
            model,
            { messages },
            {
              ...(agent.thinkingLevel === 'off' ? {} : { reasoning: agent.thinkingLevel }),
              signal: AbortSignal.any([AbortSignal.timeout(180_000), signal]),
            },
          )
          .result(),
      }
    } catch (error) {
      return { error }
    }
  }
  const started = startPingIfCacheOpen()
  if (!started) {
    await commitPingOutcomeAndUsage(host, id, {
      at,
      provider,
      model: found.model,
      error: 'skipped: paused or expired',
    })
    return
  }
  let answer: AssistantMessage
  try {
    if ('error' in started) throw started.error
    answer = await started.answer
  } catch (error) {
    await commitPingOutcomeAndUsage(host, id, {
      at,
      provider,
      model: found.model,
      error: error instanceof Error ? error.message : String(error),
    })
    return
  }
  const failed = answer.stopReason === 'error' || answer.stopReason === 'aborted'
  await commitPingOutcomeAndUsage(
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

async function tick(host: ExtensionHost, signal: AbortSignal) {
  if (host.want(PauseApi)?.paused()) return
  const doc = await read(host)
  if (doc.off) return
  const now = Date.now()
  const found = await activity(host, doc, now)
  if (!found?.lastRequest || !due({ now, ...found })) return
  await sendOneShotPingWithoutSession(
    host,
    {
      ...found,
      lastRequest: found.lastRequest,
      previous: doc.last?.at,
    },
    signal,
  )
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
  host.need(ConversationsApi)
  host.want(PauseApi)
  host.react(
    'user-input',
    [UserInputEvent],
    async (tx, { data, at }) => {
      if ((await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate !== data.conversation) return
      ;(await tx.doc(State, ROOT_CONVERSATION_ID)).inputAt = Date.parse(at)
    },
    { from: 'now' },
  )
  host.onOpen(async (opened) => {
    const released = new AbortController()
    let running: Promise<void> | undefined
    opened.defer(async () => {
      released.abort()
      await running
    })
    opened.defer(
      every(CACHE_CHECK_INTERVAL_MS, () => {
        running ??= tick(host, released.signal)
          .catch((error: unknown) => host.notice(`Keep warm: ${String(error)}`))
          .finally(() => {
            running = undefined
          })
      }),
    )
  })
  return defineExtension({ name: 'keep-warm' })
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
      await action.uiChanged(tx, { key: 'keep-warm.on', value: on, previous: !on })
      if (on) delete doc.off
      else doc.off = true
    }, context)
    return state(host)
  }),
}
export const userActions = ['set']
