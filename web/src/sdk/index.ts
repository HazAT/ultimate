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
export { ROOT } from './api.ts'
export { renderEntry } from './entry-renderer.tsx'
export { events, useEvent } from './events.ts'
export { resumed } from './resume.ts'
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
export {
  Conversation,
  Dock,
  Header,
  Panels,
  Sidebar,
  Slot,
  StatusLine,
} from '../app/primitives.tsx'
/** The title bar's project chip, for an extension that replaces it in `titlebar.project` with a menu. */
export { ProjectChip, projectHeading, projectTitle, Wordmark } from '../app/titlebar.tsx'
/** Isolates another extension's component you render, such as a document renderer: it throws into an error card. */
export { ExtensionBoundary } from '../app/boundary.tsx'
/** The transcript's and composer's reading column classes, for a card that sits in that column. */
export { column } from '../app/layout.ts'
/** The transcript's card: a bordered section with the brand accent on its left edge. */
export { Card } from '../app/card.tsx'
/** A card that folds to one quiet line in compact mode, and whether one is open; the reader's choice survives reloads. */
export { Fold, useFold } from '../app/fold.tsx'
/** The entries a go-back set aside, which the model's context leaves out. */
export { setAsideIds } from '../app/compact.ts'
/** A message's footer as the transcript shows it: details such as usage, time, copy, go back and a reference link. */
export { MessageActions } from '../app/message-actions.tsx'
/** A turn of the user's as the transcript shows a typed one; `text` gives the words a delivered message carries. */
export { UserText, UserView } from '../app/user-turn.tsx'
export { useTranscriptScroll } from '../app/transcript.tsx'
/** Renders with the values other extensions provide for your point, or through them (`Rendered`); see `definePoint`. */
export { AllProvided, Provided, Rendered } from '../app/boundary.tsx'
export { ConversationScope } from './conversation-scope.tsx'
/** The conversation of the `ConversationScope` around an element, or undefined outside every scope. */
export { scopeOf } from './conversation-scope.tsx'
/** Mounts a Solid component (`*.solid.tsx`) where React renders; its code uses `@/sdk/solid`. */
export { island } from './island.tsx'
/** Sends what the composer inside it submits somewhere else, such as a new side chat; see `composer` renderers. */
export { Composer, ComposerRedirect } from '../app/composer.tsx'
export { fillComposer, insertIntoComposer } from '../app/drafts.ts'
export type { ComposerTarget } from '../app/composer.tsx'
export { api, bundle, switched } from './client.ts'
/** The page's ui-sdk agent bridge: `bridge()` drives and observes its components. */
export { uiAgent } from './client.ts'
export type { UiAgent } from './agent.ts'
/** As in `@/sdk/solid`: attribute the server writes `write` starts to the agent when `source` is `agent`. */
export { writingAs } from './writer.ts'
/** Who the write being made now is attributed to, to carry past an `await` or a later effect. */
export { writerNow } from './writer.ts'
export { ActionError } from './api.ts'
export type { ActionOptions, Api } from './api.ts'
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
  useDocumentRenderers,
  useEvents,
  useExtensionUiState,
  useExtensions,
  useCopy,
  useModels,
  useNotices,
  useNow,
  usePanels,
  useRestart,
  useReady,
  useStore,
  useSystem,
  useTasks,
  useToolDuration,
  useTranscript,
  useUiState,
  useUltimate,
} from './hooks.ts'
export type { ActionState, ConversationState, Restart } from './hooks.ts'
export { defineEvent } from '../../../shared/events.ts'
export type { EventContext, EventData, EventRecord, EventToken } from '../../../shared/events.ts'
export { touchKeyboard, useViewport } from './viewport.ts'
export type { Viewport } from './viewport.ts'
export type { Connection, State } from './store.ts'
export type { DocumentItem } from './registry.ts'
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
} from './format.ts'
/** Class names joined, Tailwind conflicts resolved: `cn('px-2', active && 'bg-accent')`. */
export { cn } from 'cn'
export { formatKeys } from './keys.ts'
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
