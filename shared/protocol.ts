import type {
  ConversationId,
  TaskId,
  EntryId,
  ConversationView as PiWindowInEntryIdOrder,
  EntryRecord,
  JsonObject,
  ModelRef,
  TaskGraph,
} from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord/json'
import type { Op } from '@earendil-works/chord/delta'
import type { AuthType, ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { UiSource } from './events.ts'

export const imageMimeTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
export const maxImageBytes = 2 * 1024 * 1024
export const maxImages = 4

export interface SubmitRequest {
  text: string
  images?: { data: string; mimeType: string }[]
  whenBusy?: 'steer' | 'followUp'
}
export interface SubmitResponse {
  submissionId: number
}
export interface ConfigureRequest {
  model?: ModelRef
  thinkingLevel?: ModelThinkingLevel
}
export type StreamedView = PiWindowInEntryIdOrder
type NewestFirstEntries = EntryRecord[]
type ExclusiveHistoryCursor = EntryId
export function historyCursorFromStreamBefore(
  entryImmediatelyBeforeWindow: StreamedView['before'],
): ExclusiveHistoryCursor | undefined {
  return entryImmediatelyBeforeWindow === undefined
    ? undefined
    : ((entryImmediatelyBeforeWindow + 1) as EntryId)
}
export interface HistoryResponse {
  entries: NewestFirstEntries
  before?: ExclusiveHistoryCursor
}
export interface CompactResponse {
  taskId: TaskId
}
export interface EmptyResponse {
  ok: true
}
type UnixTimestampMs = number
export interface ConversationSummary {
  id: ConversationId
  parentConversationId?: ConversationId
  branchOf?: { conversationId: ConversationId; at: EntryId }
  ownerTaskId?: TaskId
  label?: string
  title?: string
  cwd?: string
  busy: boolean
  inputAt?: UnixTimestampMs
  answerAt?: UnixTimestampMs
}
export interface CreateConversationRequest {
  cwd?: string
  title?: string
}
export interface CreateConversationResponse {
  id: ConversationId
}
export interface ExtensionActionRequest {
  args: JsonValue
  conversationId?: ConversationId
}
export interface ExtensionActionResponse {
  result?: JsonValue
  rev?: number
  superseded?: true
}
type AlwaysEnabledCore = true
export interface ExtensionInfo {
  name: string
  enabled: boolean
  core?: AlwaysEnabledCore
  requires?: string[]
  offForMissing?: string[]
  source: 'builtin' | 'user' | 'project'
  replaces?: 'builtin'
  layer: 'default' | 'user' | 'project' | 'folder'
  path: string
  actions: string[]
  events: string[]
  readme?: string
  facets: { server: boolean; web: boolean }
  server?: {
    loadedAt?: string
    tools: { name: string; description: string }[]
    sections: string[]
    hooks: number
    docs: string[]
    secrets?: { name: string; description: string; url?: string; provider?: string }[]
    error?: string
  }
}
export interface BuildEntry {
  id: string
  at: string
  generation: number
  changed: string[]
}
export interface BuildInfo extends BuildEntry {
  core: string
  lib: string
  extensions: Record<string, string>
  history: BuildEntry[]
}
export interface SystemInfo {
  build: BuildInfo
  machine: {
    hostname: string
    home: string
    platform: string
    release: string
    arch: string
    cpuModel: string
    cpuCount: number
    totalMemory: number
    freeMemory: number
    user: string
  }
  process: {
    pid: number
    node: string
    startedAt: string
    generation: number
    url: string
    activationError?: string
  }
  access: { origins: string[] }
  persistence: { kind: 'sqlite'; path: string; sizeBytes: number; walBytes: number }
  execution: { kind: 'node-local'; defaultCwd: string }
  project: {
    root: string
    name: string
    config: boolean
    decision: boolean | null
    readme?: string
    settings: Record<string, JsonValue>
    settingsError?: string
  }
  code: { ultimateRoot: string; branch: string; sha: string; dirty: boolean; coreStale?: boolean }
  web: {
    id: string
    changed: string[]
    building?: boolean
    left?: { file: string; error: string }[]
    error?: string
  }
  extensionDiagnostics: string[]
  extensions: ExtensionInfo[]
  skills: {
    name: string
    description: string
    path: string
    scope: 'clone' | 'user' | 'project'
    overrides: string[]
    manual?: true
  }[]
  skillDiagnostics: { type: 'warning' | 'error' | 'collision'; message: string; path?: string }[]
  contextFiles: string[]
}
export interface Notice {
  level: 'info' | 'warning' | 'error'
  message: string
}
export interface ModelsResponse {
  providers: {
    id: string
    name: string
    authTypes: { type: AuthType; name: string }[]
    status: ReturnType<ModelRuntime['getProviderAuthStatus']>
    isUsingSubscription: boolean
  }[]
  models: {
    provider: string
    id: string
    name: string
    contextWindow: number
    maxTokens: number
    reasoning: boolean
    thinkingLevels: ModelThinkingLevel[]
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
    available: boolean
  }[]
}
export interface UiOp {
  key: string
  value?: JsonValue
  who?: UiSource['source']
  seq?: number
}
export interface UiUpdateRequest {
  ops: UiOp[]
  tab?: string
}
export const UI_REVISION = 'ui.rev'
export const SOURCE_HEADER = 'x-ultimate-source'
type CommittedUiRevision = number
export type UiUpdateResponse = { ok: true; rev: CommittedUiRevision }
type StreamHandshakeBeforeSubscriptions = { id: string }
type HttpStatusOfRefusedOpen = number
export interface ReadSpec {
  extension: string
  action: string
  args: JsonValue
  conversation?: number
}
export type ViewSubscription = { sub: number; conversation?: number; docs: string[]; view: boolean }
export type ReadSubscription = { sub: number; read: ReadSpec; every?: ReadAgainAfterMs }
export const MAX_SUBSCRIPTION_BATCH_BYTES = 1024 * 1024
export interface SubscriptionsRequest {
  subscribe: (ViewSubscription | ReadSubscription)[]
  unsubscribe: number[]
}
type ReadAgainAfterMs = number
export type ReadPayload = { result: JsonValue } | { error: string; status: number }
export type ReadEvent = ReadPayload & { rev: number }
export interface SubscriptionsAnswer {
  ok: true
  refused: Record<number, HttpStatusOfRefusedOpen>
}
export interface ServerEvents {
  stream: StreamHandshakeBeforeSubscriptions
  system: SystemInfo
  conversations: ConversationSummary[]
  view: StreamedView
  ops: readonly Op[]
  ui: { value: Readonly<Record<string, JsonValue>> }
  uiOps: { ops: readonly Op[] }
  doc: { kind: string; value: Readonly<JsonObject> | null }
  docOps: { kind: string; ops: readonly Op[] }
  tasks: TaskGraph
  conversationsOps: readonly Op[]
  tasksOps: readonly Op[]
  notice: Notice
  read: ReadEvent
}
