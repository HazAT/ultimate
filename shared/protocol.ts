import type { JsonValue } from '@earendil-works/chord'
import type { Op } from '@earendil-works/chord/delta'
import type { AuthType, ModelThinkingLevel } from '@earendil-works/pi-ai'
import type {
  ConversationView,
  EntryRecord,
  JsonObject,
  ModelRef,
  TaskGraph,
} from '@earendil-works/pi-durable'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'

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
/**
 * A conversation's view as `/api/events` streams it: Pi's window over its newest entries in id order, head markers
 * where they were written, with `before` the entry just before the window (absent when the window starts the
 * transcript), so `/history` pages on from `before + 1`.
 */
export type StreamedView = ConversationView
/** Stored history, newest first; `before` is the exclusive cursor for the next page. */
export interface HistoryResponse {
  entries: EntryRecord[]
  before?: number
}
export interface CompactResponse {
  taskId: number
}
export interface EmptyResponse {
  ok: true
}
export interface ConversationSummary {
  id: number
  /** The conversation that owns this subagent or lander. */
  parentConversationId?: number
  /** The source and history entry of an ownerless branch. */
  branchOf?: { conversationId: number; at: number }
  ownerTaskId?: number
  /** A short name its creator gave it, shown before its title. */
  label?: string
  title?: string
  cwd?: string
  busy: boolean
  /** Timestamp (ms) of its latest user message; absent when it has none. */
  inputAt?: number
  /** Timestamp (ms) of its latest assistant message; absent when it has none. */
  answerAt?: number
}
export interface CreateConversationRequest {
  cwd?: string
  title?: string
}
export interface CreateConversationResponse {
  id: number
}
export interface ExtensionActionRequest {
  args: JsonValue
  conversationId?: number
}
export interface ExtensionActionResponse {
  result: JsonValue
}
export interface ExtensionInfo {
  name: string
  enabled: boolean
  /** Core tier (`export const tier = 'core'` in its api.ts): always on; settings cannot disable it. */
  core?: true
  source: 'builtin' | 'user' | 'project'
  replaces?: 'builtin'
  layer: 'default' | 'user' | 'project' | 'folder'
  path: string
  actions: string[]
  readme?: string
  facets: { server: boolean; web: boolean }
  server?: {
    loadedAt?: string
    /** Each tool's name and the first line of its description. */
    tools: { name: string; description: string }[]
    sections: string[]
    hooks: number
    docs: string[]
    /** `provider`: a model provider whose configured auth stands in for the secret. */
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
  /**
   * The web bundle served now; a page on another id reloads onto it. `changed` lists the sources that changed since the
   * previous bundle, relative to the Ultimate root when inside it.
   */
  web: { id: string; changed: string[] }
  extensionDiagnostics: string[]
  extensions: ExtensionInfo[]
  /**
   * Loaded skills: `scope` is where the winner came from, `overrides` the paths of same-named skills in earlier scopes,
   * `manual` a skill with `disable-model-invocation` that the model is never shown.
   */
  skills: {
    name: string
    description: string
    path: string
    scope: 'clone' | 'user' | 'project'
    overrides: string[]
    manual?: true
  }[]
  /** Pi's warnings and errors from loading skills: malformed files, missing descriptions, invalid names. */
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
/** `POST /api/ui`: set and delete keys of the root conversation's `ultimate.ui` document. */
export interface UiUpdateRequest {
  set?: Record<string, JsonValue>
  delete?: string[]
}
/** The document key counting UI commits; each `POST /api/ui` increments it in its own commit. */
export const UI_REVISION = 'ui.rev'
/** The revision the update committed as: the stream shows it once its `ui.rev` reaches this. */
export interface UiUpdateResponse {
  ok: true
  rev: number
}
/**
 * Events of `GET /api/events`, one stream per browser tab. `stream` comes first with the id that
 * `POST /api/events/<stream>/<sub>` (`{ conversation?, docs?, view? }`) and `DELETE` use to open and close a subscription
 * of a conversation; `view`, `ops`, `doc` and `docOps` belong to one, whose id is their first data line.
 */
export interface ServerEvents {
  stream: { id: string }
  system: SystemInfo
  conversations: ConversationSummary[]
  view: StreamedView
  ops: readonly Op[]
  ui: { value: Readonly<Record<string, JsonValue>> }
  uiOps: { ops: readonly Op[] }
  doc: { kind: string; value: Readonly<JsonObject> | null }
  docOps: { kind: string; ops: readonly Op[] }
  tasks: TaskGraph
  notice: Notice
}
