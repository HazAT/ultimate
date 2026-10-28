import { randomUUID } from 'node:crypto'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { AuthEvent, AuthPrompt, AuthType } from '@earendil-works/pi-ai'
import {
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Cursor } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { LoginChanged } from './api.ts'
import { implementAction } from '../../lib/actions.ts'
import type { ActionInput } from '../../lib/actions.ts'
import {
  AnswerAction,
  CancelAction,
  FamiliesAction,
  LoginAction,
  LoginDoc,
  LogoutAction,
  SaveFamiliesAction,
} from './refs.ts'
import type { SaveFamilies } from './refs.ts'
import { familiesView, saveFamilies } from './families.ts'
import { fallback } from './fallback.ts'

/** A Pi type as a document holds it: plain JSON, arrays mutable. */
type Json<T> = T extends readonly (infer U)[]
  ? Json<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Json<T[K]> }
    : T
type WirePrompt<T> = T extends AuthPrompt ? Omit<T, 'signal'> : never
/** One login flow as the browser sees it. Answers and credentials never enter it. */
export type LoginFlow = {
  provider: string
  type: AuthType
  status: 'running' | 'complete' | 'cancel' | 'error'
  /** The prompt waiting for an answer. */
  prompt?: Json<WirePrompt<AuthPrompt>>
  events: Json<AuthEvent>[]
  error?: string
}
/** The login flows started from a conversation, by flow id; the login dialog streams it with `useDoc`. */
export const Logins = defineDoc<{ flows: Record<string, LoginFlow> }>({
  kind: LoginDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ flows: {} }),
})
export const docs = [Logins]

/** A running flow: process-local, so a flow the document shows running without one here died with its process. */
interface Flow {
  controller: AbortController
  answer?: (value: string) => void
  /** Document changes, applied in order. */
  writes: Promise<void>
}
/** Finished flows a conversation's document keeps. */
const kept = 10

function liveFlows(host: ExtensionHost) {
  return host.resource('models.login', () => {
    const live = new Map<string, Flow>()
    host.onClose(async () => {
      for (const flow of live.values()) flow.controller.abort()
    })
    return live
  })
}

const field = <Name extends string>(args: ActionInput<Record<Name, unknown>>, name: Name) =>
  args && typeof args === 'object' && !Array.isArray(args) ? args[name] : undefined
function text<Name extends string>(args: ActionInput<Record<Name, unknown>>, name: Name) {
  const value = field(args, name)
  if (typeof value !== 'string' || !value) throw new Error(`Expected ${name}`)
  return value
}
function running(host: ExtensionHost, args: ActionInput<{ flowId: string }>) {
  const flow = liveFlows(host).get(text(args, 'flowId'))
  if (!flow) throw new Error('Unknown login flow')
  return flow
}
/** Prompts and events as plain JSON: a document holds no `undefined`. */
const json = <T>(value: T): Json<T> => JSON.parse(JSON.stringify(value))

export const userActions = ['login', 'answer', 'cancel', 'logout']

/**
 * Record that `provider`'s login changed: its recorded health is meaningless now, and health resets it to unknown
 * (`extensions/health`).
 */
const loginChanged = async (host: ActionContext['host'], provider: string) =>
  host
    .harness()
    .commit((tx) => host.emit(tx, LoginChanged, { provider }), context)
    .catch((error: unknown) => {
      // Health is advisory: the login itself succeeded, and the next call corrects the record.
      console.error('models: login change not recorded:', error)
    })

export const actions = {
  /** The families, who runs on which, and the concurrency caps, for the families dialog. */
  families: implementAction(FamiliesAction, (_args, { host }) => familiesView(host)),
  /** Save the families dialog: families, assignments, caps; optionally move running conversations along. */
  saveFamilies: implementAction(SaveFamiliesAction, (args, { host }) => {
    if (!args || typeof args !== 'object' || Array.isArray(args))
      throw new Error('Expected families')
    return saveFamilies(host, args as SaveFamilies)
  }),
  /** Start a login flow for the calling conversation and resolve with its id; the document shows its progress. */
  login: implementAction(LoginAction, async (args, { host, conversationId }) => {
    const provider = text(args, 'provider')
    const type = field(args, 'type')
    if (type !== 'api_key' && type !== 'oauth') throw new Error('Invalid auth type')
    if (
      !host.modelRuntime.getProvider(provider)?.auth[type === 'oauth' ? 'oauth' : 'apiKey']?.login
    )
      throw new Error('Unsupported provider or login type')
    const live = liveFlows(host)
    const harness = host.harness()
    const id = (conversationId ?? ROOT_CONVERSATION_ID) as ConversationId
    const flowId = randomUUID()
    await harness.commit(async (tx) => {
      if (!(await tx.conversation(id))) throw new Error('Unknown conversation')
      const { flows } = await tx.doc(Logins, id)
      const finished = Object.keys(flows).filter((key) => flows[key].status !== 'running')
      for (const key of finished.slice(0, -kept)) delete flows[key]
      flows[flowId] = { provider, type, status: 'running', events: [] }
    }, context)
    const flow: Flow = { controller: new AbortController(), writes: Promise.resolve() }
    const update = (change: (state: LoginFlow) => void) => {
      flow.writes = flow.writes
        .then(() =>
          host.harness().commit(async (tx) => {
            const state = (await tx.doc(Logins, id)).flows[flowId]
            if (state) change(state)
          }, context),
        )
        // The harness closes only with the process; the next start marks the flow cancelled.
        .catch((error: unknown) => console.error('models: login document not updated:', error))
      return flow.writes
    }
    live.set(flowId, flow)
    const { signal } = flow.controller
    void host.modelRuntime
      .login(provider, type, {
        signal,
        prompt: (prompt: AuthPrompt) =>
          new Promise<string>((resolve, reject) => {
            const signals = [signal, prompt.signal].filter((item): item is AbortSignal => !!item)
            const cleanup = () => {
              for (const item of signals) item.removeEventListener('abort', abort)
              delete flow.answer
              // oxlint-disable-next-line typescript/no-floating-promises -- update catches and logs document write failures.
              void update((state) => delete state.prompt)
            }
            const abort = () => {
              cleanup()
              reject(new Error('Login cancelled'))
            }
            flow.answer = (value) => {
              cleanup()
              resolve(value)
            }
            for (const item of signals) {
              if (item.aborted) {
                abort()
                return
              }
              item.addEventListener('abort', abort, { once: true })
            }
            const { signal: _signal, ...wire } = prompt
            // oxlint-disable-next-line typescript/no-floating-promises -- update catches and logs document write failures.
            void update((state) => {
              state.prompt = json(wire)
            })
          }),
        notify: (event) => void update((state) => state.events.push(json(event))),
      })
      .then(
        () => (signal.aborted ? 'cancel' : 'complete'),
        // Provider errors may include secrets or callback codes; never forward them.
        () => (signal.aborted ? 'cancel' : 'error'),
      )
      .then(async (status) => {
        live.delete(flowId)
        if (status === 'complete') await loginChanged(host, provider)
        return update((state) => {
          state.status = status
          delete state.prompt
          if (status === 'error') state.error = 'Login failed'
        })
      })
      .catch(() => host.notice('Login flow finalization failed'))
    return { flowId }
  }),
  /** Answer the flow's pending prompt; an empty answer is allowed. */
  answer: implementAction(AnswerAction, async (args, { host }) => {
    const flow = running(host, args)
    const value = field(args, 'value')
    if (typeof value !== 'string') throw new Error('Expected value')
    if (!flow.answer) throw new Error('No pending prompt for flow')
    flow.answer(value)
    // The prompt leaves the document before the UI hears back.
    await flow.writes
    return null
  }),
  cancel: implementAction(CancelAction, async (args, { host }) => {
    running(host, args).controller.abort()
    return null
  }),
  /** Remove the provider's stored credential, which pi shares. */
  logout: implementAction(LogoutAction, async (args, { host }) => {
    const provider = text(args, 'provider')
    await host.modelRuntime.logout(provider)
    await loginChanged(host, provider)
    return null
  }),
}

export default function models(host: ExtensionHost) {
  const live = liveFlows(host)
  // Each facet registers its own, so it reads Logins with this load's token: flows no live login drives (those of a
  // previous process) are marked cancelled.
  host.onOpen(async () => {
    const harness = host.harness()
    const ids: ConversationId[] = []
    let cursor: Cursor | undefined
    do {
      const page = await harness.commit((tx) => tx.scanConversations({}, 256, cursor), context)
      ids.push(...page.items.map((record) => record.id))
      cursor = page.next
    } while (cursor !== undefined)
    for (const id of ids) {
      const dead = (records: Readonly<Record<string, LoginFlow>>) =>
        Object.keys(records).filter(
          (flowId) => records[flowId].status === 'running' && !live.has(flowId),
        )
      if (!dead((await harness.snapshot(Logins, id, context))?.flows ?? {}).length) continue
      await harness.commit(async (tx) => {
        const { flows } = await tx.doc(Logins, id)
        for (const flowId of dead(flows)) {
          flows[flowId].status = 'cancel'
          delete flows[flowId].prompt
        }
      }, context)
    }
  })
  return defineExtension({
    name: 'models',
    hooks: [
      hook(GenerationTask, {
        // Pi upstream: @earendil-works/pi-durable@1.4.0 — patched transactional beforeInput hook. Every run's first
        // input is placed through it (a typed input, a delivery, a queued follow-up), before the run reads its agent.
        beforeInput: (_input, { tx, conversationId }) => fallback(host, tx, conversationId),
      }),
    ],
  })
}
