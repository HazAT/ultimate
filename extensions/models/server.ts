import { randomUUID } from 'node:crypto'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { AuthEvent, AuthPrompt, AuthType } from '@earendil-works/pi-ai'
import {
  configure,
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Family, LoginChanged } from './api.ts'
import { implementAction } from '../../lib/actions.ts'
import type { ActionInput } from '../../lib/actions.ts'
import {
  AnswerAction,
  CancelAction,
  FamiliesAction,
  LoginAction,
  LoginDoc,
  LogoutAction,
  RefreshCatalogAction,
  SaveFamiliesAction,
  SetDefaultAction,
  SetFamilyAction,
} from './refs.ts'
import type { SaveFamilies } from './refs.ts'
import { DEFAULT_FAMILY } from '../../lib/families.ts'
import { familiesView, saveFamilies, setDefault } from './families.ts'
import { fallback } from './fallback.ts'
import { inProcess } from '../../lib/errors.ts'

type MutableJson<T> = T extends readonly (infer U)[]
  ? MutableJson<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: MutableJson<T[K]> }
    : T
type PromptWithoutSignal<T> = T extends AuthPrompt ? Omit<T, 'signal'> : never
export type LoginFlow = {
  provider: string
  type: AuthType
  status: 'running' | 'complete' | 'cancel' | 'error'
  prompt?: MutableJson<PromptWithoutSignal<AuthPrompt>>
  events: MutableJson<AuthEvent>[]
  error?: string
}
export const Logins = defineDoc<{ flows: Record<string, LoginFlow> }>({
  kind: LoginDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ flows: {} }),
})
export const docs = [Logins, Family]

interface ProcessLocalLoginFlow {
  controller: AbortController
  answer?: (value: string) => void
  writes: Promise<void>
}
const FINISHED_LOGIN_FLOW_LIMIT = 10

function liveFlows(host: ExtensionHost) {
  return host.resource('models.login', () => {
    const live = new Map<string, ProcessLocalLoginFlow>()
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
const withoutUndefined = <T>(value: T): MutableJson<T> => JSON.parse(JSON.stringify(value))

export const userActions = ['login', 'answer', 'cancel', 'logout']

const invalidateLoginHealthBestEffort = async (host: ActionContext['host'], provider: string) =>
  host
    .harness()
    .commit((tx) => host.emit(tx, LoginChanged, { provider }), context)
    .catch((error: unknown) => {
      console.error('models: login change not recorded:', error)
    })

export const actions = {
  families: implementAction(FamiliesAction, (_args, { host }) => familiesView(host)),
  saveFamilies: implementAction(SaveFamiliesAction, (args, { host }) => {
    if (!args || typeof args !== 'object' || Array.isArray(args))
      throw new Error('Expected families')
    return saveFamilies(host, args as SaveFamilies)
  }),
  setFamily: implementAction(SetFamilyAction, async (args, { host, conversationId }) => {
    const family = field(args, 'family')
    if (family !== null && (typeof family !== 'string' || !family))
      throw new Error('Expected family: a family name or null')
    const id = conversationId ?? ROOT_CONVERSATION_ID
    await host.harness().commit(async (tx) => {
      if (!(await tx.conversation(id))) throw new Error('Unknown conversation')
      ;(await tx.doc(Family, id)).name = family
    }, context)
    return null
  }),
  setDefault: implementAction(SetDefaultAction, async (args, { host, conversationId }) => {
    const change = await setDefault(host, text(args, 'model'))
    if (conversationId !== undefined)
      await host.harness().commit(async (tx) => {
        const id = conversationId
        if (!(await tx.conversation(id))) throw new Error('Unknown conversation')
        await configure(tx, id, change)
        ;(await tx.doc(Family, id)).name = DEFAULT_FAMILY
      }, context)
    return null
  }),
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
    const flowId = randomUUID()
    await harness.commit(async (tx) => {
      if (conversationId !== undefined && !(await tx.conversation(conversationId)))
        throw new Error('Unknown conversation')
      const { flows } = await tx.doc(Logins, ROOT_CONVERSATION_ID)
      const finished = Object.keys(flows).filter((key) => flows[key].status !== 'running')
      for (const key of finished.slice(0, -FINISHED_LOGIN_FLOW_LIMIT)) delete flows[key]
      flows[flowId] = { provider, type, status: 'running', events: [] }
    }, context)
    const flow: ProcessLocalLoginFlow = {
      controller: new AbortController(),
      writes: Promise.resolve(),
    }
    const queueLoginDocumentUpdate = (change: (state: LoginFlow) => void) => {
      flow.writes = flow.writes
        .then(() =>
          host.harness().commit(async (tx) => {
            const state = (await tx.doc(Logins, ROOT_CONVERSATION_ID)).flows[flowId]
            if (state) change(state)
          }, context),
        )
        .catch((error: unknown) => console.error('models: login document not updated:', error))
      return flow.writes
    }
    live.set(flowId, flow)
    const { signal } = flow.controller
    const credentialSafeLoginRejection = (): 'cancel' | 'error' =>
      signal.aborted ? 'cancel' : 'error'
    inProcess(
      'the login flow belongs to this process; open cancels stranded flows',
      host.modelRuntime
        .login(provider, type, {
          signal,
          prompt: (prompt: AuthPrompt) =>
            new Promise<string>((resolve, reject) => {
              const signals = [signal, prompt.signal].filter((item): item is AbortSignal => !!item)
              const cleanup = () => {
                for (const item of signals) item.removeEventListener('abort', abort)
                delete flow.answer
                inProcess(
                  'the login prompt belongs to this process; open cancels stranded flows',
                  queueLoginDocumentUpdate((state) => delete state.prompt),
                )
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
              inProcess(
                'the login prompt belongs to this process; open cancels stranded flows',
                queueLoginDocumentUpdate((state) => {
                  state.prompt = withoutUndefined(wire)
                }),
              )
            }),
          notify: (event) =>
            inProcess(
              'login notifications belong to this process; open cancels stranded flows',
              queueLoginDocumentUpdate((state) => state.events.push(withoutUndefined(event))),
            ),
        })
        .then(() => (signal.aborted ? 'cancel' : 'complete'), credentialSafeLoginRejection)
        .then(async (status) => {
          live.delete(flowId)
          if (status === 'complete') await invalidateLoginHealthBestEffort(host, provider)
          return queueLoginDocumentUpdate((state) => {
            state.status = status
            delete state.prompt
            if (status === 'error') state.error = 'Login failed'
          })
        })
        .catch(() => host.notice('Login flow finalization failed')),
    )
    return { flowId }
  }),
  answer: implementAction(AnswerAction, async (args, { host }) => {
    const flow = running(host, args)
    const value = field(args, 'value')
    if (typeof value !== 'string') throw new Error('Expected value')
    if (!flow.answer) throw new Error('No pending prompt for flow')
    flow.answer(value)
    await flow.writes
    return null
  }),
  cancel: implementAction(CancelAction, async (args, { host }) => {
    running(host, args).controller.abort()
    return null
  }),
  logout: implementAction(LogoutAction, async (args, { host }) => {
    const provider = text(args, 'provider')
    await host.modelRuntime.logout(provider)
    await invalidateLoginHealthBestEffort(host, provider)
    return null
  }),
  refreshCatalog: implementAction(RefreshCatalogAction, async (_args, { host, signal }) => {
    const { errors } = await host.modelRuntime.refresh({ allowNetwork: true, force: true, signal })
    return {
      errors: Object.fromEntries([...errors].map(([provider, error]) => [provider, error.message])),
    }
  }),
}

export default function models(host: ExtensionHost) {
  const live = liveFlows(host)
  host.onOpen(async () => {
    await host.harness().commit(async (tx) => {
      const { flows } = await tx.doc(Logins, ROOT_CONVERSATION_ID)
      for (const [flowId, flow] of Object.entries(flows))
        if (flow.status === 'running' && !live.has(flowId)) {
          flow.status = 'cancel'
          delete flow.prompt
        }
    }, context)
  })
  return defineExtension({
    name: 'models',
    hooks: [
      hook(GenerationTask, {
        // Pi upstream: @earendil-works/pi-durable@1.6.0 — patched transactional beforeInput hook.
        beforeInput: (_input, { tx, conversationId }) => fallback(host, tx, conversationId),
      }),
    ],
  })
}
