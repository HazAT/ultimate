import { parseConversationId } from '../../../lib/ids.ts'
import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
import type {
  CompactResponse,
  ConfigureRequest,
  CreateConversationRequest,
  CreateConversationResponse,
  EmptyResponse,
  HistoryResponse,
  ExtensionActionRequest,
  ExtensionActionResponse,
  SubmitRequest,
  SubmitResponse,
  UiUpdateRequest,
  UiUpdateResponse,
} from '../../../shared/protocol.ts'
import { SOURCE_HEADER } from '../../../shared/protocol.ts'
import { writerNow } from './writer.ts'
import type { UiWho } from './writer.ts'
import type { ActionRef } from '../../../shared/extension-api.ts'
import { errorMessage } from './format.ts'
import type { Store } from './store.ts'

/** Per-call options of `api.action`. */
export type ActionOptions = {
  conversationId?: ConversationId
  signal?: AbortSignal
  keepalive?: boolean
}

export type ActionArgs<Args, Options> = null extends Args
  ? [args?: Args, options?: Options]
  : [args: Args, options?: Options]

/** The root conversation's id (`ROOT_CONVERSATION_ID` in Pi Durable): Ultimate's one ongoing conversation. */
export const ROOT = parseConversationId(1)

/** A failed `api.action()`; one nobody catches becomes a notice. */
export class ActionError extends Error {
  readonly extension: string
  readonly action: string
  /** HTTP status: 404 for an unknown action, 500 when it threw. */
  readonly status: number
  readonly rev?: number
  readonly superseded?: boolean
  constructor(
    extension: string,
    action: string,
    status: number,
    message: string,
    rev?: number,
    superseded?: boolean,
  ) {
    super(message)
    this.name = 'ActionError'
    this.extension = extension
    this.action = action
    this.status = status
    this.rev = rev
    this.superseded = superseded
  }
}

export const actionMessage = (error: ActionError) =>
  `${error.extension}/${error.action}: ${error.message}`

export class HttpError extends Error {
  readonly status: number
  readonly rev?: number
  readonly superseded?: boolean
  constructor(status: number, message: string, rev?: number, superseded?: boolean) {
    super(message)
    this.status = status
    this.rev = rev
    this.superseded = superseded
  }
}

async function postJson<T>(
  request: typeof fetch,
  path: string,
  body: object = {},
  {
    keepalive = false,
    signal,
    who = writerNow(),
  }: { keepalive?: boolean; signal?: AbortSignal; who?: UiWho } = {},
): Promise<T> {
  const response = await request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [SOURCE_HEADER]: who,
    },
    body: JSON.stringify(body),

    keepalive,
    signal,
  })
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => ({}))
    const error =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `${response.status} ${response.statusText}`
    const rev =
      data && typeof data === 'object' && 'rev' in data && Number.isSafeInteger(data.rev)
        ? (data.rev as number)
        : undefined
    const superseded =
      data && typeof data === 'object' && 'superseded' in data && data.superseded === true
        ? true
        : undefined
    throw new HttpError(response.status, error, rev, superseded)
  }
  const data: unknown = await response.json()
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('Invalid response JSON')
  return data as T
}

function validActionResponse(data: unknown): data is ExtensionActionResponse {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  const record = data as Record<string, unknown>
  if (record.rev !== undefined && !Number.isSafeInteger(record.rev)) return false
  if (record.superseded !== undefined && record.superseded !== true) return false
  return Object.hasOwn(record, 'result') || typeof record.rev === 'number'
}

async function runExtensionAction<Args, Result>(
  request: typeof fetch,
  { extension, name }: ActionRef<Args, Result>,
  args: Args | undefined,
  { conversationId, signal, keepalive }: ActionOptions,
): Promise<{ result: Result; rev?: number; superseded?: true }> {
  const path = `/api/extensions/${encodeURIComponent(extension)}/actions/${encodeURIComponent(name)}`
  const body: ExtensionActionRequest = { args: args ?? null, conversationId }
  try {
    const data = await postJson<unknown>(request, path, body, { signal, keepalive })
    if (!validActionResponse(data)) throw new Error('Invalid action response')
    const { result, rev, superseded } = data
    return { result: result as Result, rev, superseded }
  } catch (error) {
    if (signal?.aborted) throw error
    const http = error instanceof HttpError ? error : undefined
    throw new ActionError(
      extension,
      name,
      http?.status ?? 0,
      errorMessage(error),
      http?.rev,
      http?.superseded,
    )
  }
}

export type ReadAction = <Args, Result>(
  ref: ActionRef<Args, Result>,
  args?: Args,
  options?: ActionOptions,
) => Promise<{ result: Result; rev?: number; superseded?: true }>

const readActions = new WeakMap<Api, ReadAction>()

export const readActionOf = (api: Api): ReadAction => readActions.get(api)!

export function createApi(store: Store, options: { fetch?: typeof fetch } = {}) {
  const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const post = <T>(
    path: string,
    body: object = {},
    call?: { keepalive?: boolean; signal?: AbortSignal; who?: UiWho },
  ) => postJson<T>(request, path, body, call)
  const shown = () => {
    const state = store.getState()
    return state.view?.conversation.id ?? state.requested ?? ROOT
  }
  const conversation = (id: ConversationId | undefined, action: string) =>
    `/api/conversations/${id ?? shown()}/${action}`

  const api = {
    submit: (
      text: string,
      whenBusy?: SubmitRequest['whenBusy'],
      id?: ConversationId,
      images?: SubmitRequest['images'],
    ) =>
      post<SubmitResponse>(conversation(id, 'submit'), {
        text,
        whenBusy,
        images,
      } satisfies SubmitRequest),

    history: async (
      id: ConversationId,
      before: EntryId,
      signal?: AbortSignal,
      after?: EntryId,
    ): Promise<HistoryResponse> => {
      const query = new URLSearchParams({ before: String(before) })
      if (after !== undefined) query.set('after', String(after))
      const response = await request(conversation(id, `history?${query}`), { signal })
      const data = await response.json()
      if (!response.ok) throw new HttpError(response.status, data.error ?? 'Could not load history')
      return data as HistoryResponse
    },
    abort: (id?: ConversationId) => post<EmptyResponse>(conversation(id, 'abort')),
    cancelSubmission: (submissionId: number, id?: ConversationId) =>
      post<EmptyResponse>(conversation(id, `inbox/${submissionId}/cancel`)),
    configure: (change: ConfigureRequest, id?: ConversationId) =>
      post<EmptyResponse>(conversation(id, 'configure'), change),
    compact: (instructions?: string, id?: ConversationId) =>
      post<CompactResponse>(conversation(id, 'compact'), { instructions }),
    createConversation: (create: CreateConversationRequest = {}) =>
      post<CreateConversationResponse>('/api/conversations', create),
    restart: () => post<unknown>('/api/restart'),

    action: async <Args, Result>(
      ref: ActionRef<Args, Result>,
      ...[args, call = {}]: ActionArgs<Args, ActionOptions>
    ): Promise<Result> => {
      const { result } = await runExtensionAction(request, ref, args, {
        ...call,
        conversationId: call.conversationId ?? shown(),
      })
      return result
    },

    updateUi: (change: UiUpdateRequest, who?: UiWho, exit?: { keepalive: boolean }) =>
      post<UiUpdateResponse>('/api/ui', change, { who, ...exit }),
  }
  readActions.set(api, (ref, args, call = {}) => runExtensionAction(request, ref, args, call))
  return api
}
export type Api = ReturnType<typeof createApi>
