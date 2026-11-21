/**
 * The extension SDK: everything a `web.tsx` needs besides components (`@/components/ui/*`, `@/components/ai/*`).
 * The guide is extensions/README.md; the hooks are in docs/extensions/sdk.md.
 */
export {
  attention,
  ComposerPlaceholder,
  ConversationKind,
  defineWebExtension,
  definePoint,
  EmptyTranscript,
  ErrorReport,
  FileUpload,
  MessageReference,
  ParkedRuns,
  provide,
  RunStart,
} from './types.ts'
export { ROOT } from '../sdk/api.ts'
export { renderEntry } from './entry-renderer.tsx'
export { events } from '../sdk/events.ts'
export { resumed } from '../sdk/resume.ts'
export type {
  CompactCallTest,
  CompactContribution,
  CompactRow,
  CompactSummaryProps,
  CompactDocs,
  CommandContribution,
  CodeBlockRenderer,
  ComposerRenderer,
  Contribution,
  DocumentContribution,
  DocumentProps,
  EntryRenderer,
  InboxRenderer,
  InlineCodeRenderer,
  LinkRenderer,
  PanelContribution,
  Point,
  Provision,
  SlotName,
  SurfaceContribution,
  ToolCallView,
  ToolLineRenderer,
  ToolRenderer,
  UltimateActions,
  UltimateContext,
  WebExtension,
} from './types.ts'
/** Building blocks of surfaces; see docs/extensions/surfaces.md. */
export { Conversation, Dock, Header, Sidebar, StatusLine, Wordmark } from './shell.tsx'
export { Slot } from './boundary.tsx'
/** The project's folder, pretty name and path from the system snapshot, as the sidebar heads it. */
export { projectHeading } from '../app/project.ts'
/** Isolates another extension's component you render, such as a document renderer: it throws into an error card. */
export { ExtensionBoundary } from './boundary.tsx'
/** The transcript's and composer's reading column classes, for a card that sits in that column. */
export { column } from '../app/layout.ts'
/** The transcript's card: a bordered section with the brand accent on its left edge. */
export { Card } from './card.tsx'
/** A card that folds to one quiet line in compact mode, and whether one is open; the reader's choice survives reloads. */
export { Fold, useFold } from './fold.tsx'
/** The entries a go-back set aside, which the model's context leaves out. */
export { setAsideIds } from '../app/compact.ts'
/** A message's footer, a user's turn and its words as the transcript shows them. */
export { MessageActions, UserText, UserView } from './transcript-parts.tsx'
export { ConversationScope } from './conversation-scope.tsx'
/** The conversation of the `ConversationScope` around an element, or undefined outside every scope. */
export { scopeOf } from './conversation-scope.tsx'
/** Mounts a Solid component (`*.solid.tsx`) where React renders; its code uses `@/sdk/solid`. */
export { island } from './island.tsx'
export { fillComposer, insertIntoComposer } from '../app/drafts.ts'
export type { ComposerTarget, SolidComposerProps } from './types.ts'
export { api, bundle, switched } from '../sdk/client.ts'
/** The page's ui-sdk agent bridge: `bridge()` drives and observes its components. */
export { uiAgent } from '../sdk/client.ts'
export type { UiAgent } from '../sdk/agent.ts'
/** As in `@/sdk/solid`: attribute the server writes `write` starts to the agent when `source` is `agent`. */
export { writingAs } from '../sdk/writer.ts'
/** Who the write being made now is attributed to, to carry past an `await` or a later effect. */
export { writerNow } from '../sdk/writer.ts'
export { ActionError } from '../sdk/api.ts'
export type { ActionOptions, Api } from '../sdk/api.ts'
export type { UseActionOptions } from './hooks.ts'
/** Typed refs for a project extension's own documents and actions; built-ins keep theirs in `refs.ts`. */
export { actionRef, docRef } from '../../../shared/extension-api.ts'
export { keepLast } from '../../../lib/errors.ts'
export type { ActionRef, DocRef } from '../../../shared/extension-api.ts'
export {
  getConversation,
  getState,
  refreshModels,
  useAction,
  useCompact,
  useCommands,
  useConnection,
  useConversation,
  useConversations,
  useConversationSummary,
  useDialog,
  useDoc,
  useDocKind,
  useDocOf,
  useEvents,
  useExtensionUiState,
  useExtensions,
  useCopy,
  useModels,
  useNotices,
  useNow,
  useRestart,
  useReady,
  useStore,
  useSystem,
  useTasks,
  useToolDuration,
  useTranscript,
  useTranscriptScroll,
  useUiState,
  useUltimate,
  useEvent,
  useViewport,
} from './hooks.ts'
export { useDocumentRenderers, usePanels } from './react-parts.ts'
export type { DocumentItem, PanelItem } from './react-parts.ts'
export type { ActionState, ConversationState, Restart } from './hooks.ts'
export { defineEvent } from '../../../shared/events.ts'
export type { EventContext, EventData, EventRecord, EventToken } from '../../../shared/events.ts'
export { touchKeyboard } from '../sdk/viewport.ts'
export type { Viewport } from '../sdk/viewport.ts'
export type { Connection, State } from '../sdk/store.ts'
export {
  elidePath,
  errorMessage,
  formatAgo,
  formatBytes,
  formatDuration,
  formatTime,
  formatTokens,
  plural,
  prettyName,
  shortenPath,
} from '../sdk/format.ts'
/** Class names joined, Tailwind conflicts resolved: `cn('px-2', active && 'bg-accent')`. */
export { cn } from 'cn'
export { formatKeys } from '../sdk/keys.ts'
export type {
  ConversationSummary,
  ExtensionActionRequest,
  ExtensionActionResponse,
  ExtensionInfo,
  ModelsResponse,
  Notice,
  SystemInfo,
} from '../../../shared/protocol.ts'
export type {
  AgentState,
  ConversationView,
  EntryRecord,
  InboxItem,
  JsonObject,
  LiveState,
  TaskGraph,
  TaskGraphNode,
  ToolDiagnostic,
  ToolSlot,
  UsageState,
} from '@earendil-works/pi-durable'
export type { JsonValue } from '@earendil-works/chord/json'
export type {
  AssistantMessage,
  AuthEvent,
  AuthPrompt,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from '@earendil-works/pi-ai'
