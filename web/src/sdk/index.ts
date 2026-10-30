/**
 * The extension SDK: everything a `web.tsx` needs besides components (`@/components/ui/*`, `@/components/ai/*`).
 * The guide is extensions/README.md.
 */
export {
  attention,
  ConversationKind,
  defineWebExtension,
  definePoint,
  ErrorReport,
  MessageReference,
  ParkedRuns,
  provide,
  RunStart,
} from './types.ts'
export { events, useEvent } from './events.ts'
export { resumed } from './resume.ts'
export type {
  CompactCallTest,
  CompactContribution,
  CompactQuietTest,
  CompactRow,
  CompactSummaryProps,
  ComposerDrop,
  ComposerInput,
  ComposerInputContribution,
  ComposerPaste,
  IntroContribution,
  CompactDocs,
  CommandContribution,
  CodeBlockRenderer,
  ComposerRenderer,
  Contribution,
  DocumentContribution,
  DocumentProps,
  EntryRenderer,
  InboxRenderer,
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
/** Building blocks of surfaces; see "Surfaces" in extensions/README.md. */
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
export { ProjectChip, projectTitle, Wordmark } from '../app/titlebar.tsx'
/** Isolates another extension's component you render, such as a document renderer: it throws into an error card. */
export { ExtensionBoundary } from '../app/boundary.tsx'
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
/** Renders with the value another extension provides for your point; see `definePoint`. */
export { AllProvided, Provided } from '../app/boundary.tsx'
export { ConversationScope } from './conversation-scope.tsx'
/** Sends what the composer inside it submits somewhere else, such as a new side chat; see `composer` renderers. */
export { Composer, ComposerRedirect, fillComposer, insertIntoComposer } from '../app/composer.tsx'
export type { ComposerTarget } from '../app/composer.tsx'
export { api, notify } from './client.ts'
export { ActionError } from './api.ts'
export type { ActionOptions, Api } from './api.ts'
export type { UseActionOptions } from './hooks.ts'
/** Typed refs for a project extension's own documents and actions; built-ins keep theirs in `refs.ts`. */
export { actionRef, docRef } from '../../../shared/extension-api.ts'
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
  useDialog,
  useDoc,
  useDocKind,
  useDocOf,
  useDocumentRenderers,
  useEvents,
  useExtensionUiState,
  useExtensions,
  useIntro,
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
/** The image types the composer attaches: what an input handler routes to `addImages`. */
export { imageMimeTypes } from '../../../shared/protocol.ts'
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
export type { JsonValue } from '@earendil-works/chord'
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
