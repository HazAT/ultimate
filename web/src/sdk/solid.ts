/** The SDK for Solid facets: contributions, live readers, client actions and shared UI parts. See docs/extensions/sdk.md. */
export {
  actionRef,
  api,
  attention,
  bundle,
  definePoint,
  defineWebExtension,
  docRef,
  events,
  notify,
  provide,
  ROOT,
  switched,
  useAction,
  useEvent,
  useEvents,
  useReady,
  writerNow,
  writingAs,
} from './hooks.ts'
export {
  closePanel,
  covered,
  fillComposer,
  focusComposer,
  getConversation,
  getState,
  insertIntoComposer,
  openPanel,
  overlays,
  refreshModels,
  runCommand,
  setUiState,
  showSurface,
  switchConversation,
  touchKeyboard,
  uncoveredComposer,
  useAgent,
  useCommands,
  useConnection,
  useConversation,
  useConversationId,
  useConversations,
  useConversationSummary,
  useDialog,
  useDoc,
  useDocKind,
  useDocOf,
  useExtensionUiState,
  useExtensions,
  useModels,
  useNotices,
  usePanels,
  useRegionOpen,
  useRestart,
  useStore,
  useSurface,
  useSystem,
  useTasks,
  useUiState,
  useViewport,
} from './hooks.ts'
export {
  codeBlockRenderers,
  ComposerPlaceholder,
  ComposerRedirect,
  composerRenderers,
  ConversationKind,
  ConversationScope,
  createTranscriptFrame,
  documentItems,
  EmptyTranscript,
  entryRenderers,
  ErrorReport,
  ExtensionName,
  FileUpload,
  inboxRenderer,
  inlineCodeRenderers,
  linkRenderers,
  messageItems,
  MessageReference,
  ParkedRuns,
  provisionsOf,
  RunStart,
  toolLine,
  toolRenderers,
  Transcript,
  useCompact,
  useTranscript,
  useTranscriptElements,
} from './hooks.ts'
export {
  cn,
  chordOf,
  column,
  elidePath,
  errorMessage,
  formatAgo,
  formatBytes,
  formatDuration,
  formatKeys,
  pageAgent,
  formatTime,
  formatTokens,
  isMac,
  keepLast,
  plural,
  prettyName,
  shortenPath,
  useCopy,
  useNow,
} from './hooks.ts'
export type {
  AuthEvent,
  AuthPrompt,
  CodeBlockRenderer,
  CommandContribution,
  CompactRow,
  CompactSummaryProps,
  ComposerTarget,
  ConversationState,
  ConversationSummary,
  DocumentItem,
  DocumentProps,
  EntryRecord,
  InlineCodeRenderer,
  JsonValue,
  LinkRenderer,
  LiveState,
  ModelsResponse,
  Notice,
  Point,
  SolidComposerProps,
  SolidEntryProps,
  SolidInboxProps,
  SolidToolProps,
  SystemInfo,
  ToolCallView,
  UltimateActions,
  UltimateContext,
  Usage,
  UseActionOptions,
  WebExtension,
} from './hooks.ts'
export { useConversationWidth, useExternal, usePageVisible } from './page.ts'
export type {
  CompactCallTest,
  CompactContribution,
  CompactDocs,
  ComposerRenderer,
  DocumentContribution,
  EntryRenderer,
  InboxRenderer,
  PanelContribution,
  Provision,
  SlotName,
  SurfaceContribution,
  ToolLineRenderer,
  ToolRenderer,
} from './types.ts'
export { ActionError } from './api.ts'
export type { ActionOptions, Api } from './api.ts'
export type { UiAgent } from './agent.ts'
export type { Connection, State } from './store.ts'
export type { Viewport } from './viewport.ts'
export type { PanelItem } from './registry.ts'
export type { ActionRef, DocRef } from '../../../shared/extension-api.ts'
export { defineEvent } from '../../../shared/events.ts'
export type { EventContext, EventData, EventRecord, EventToken } from '../../../shared/events.ts'
export type {
  ExtensionActionRequest,
  ExtensionActionResponse,
  ExtensionInfo,
} from '../../../shared/protocol.ts'
export type {
  AgentState,
  ConversationView,
  InboxItem,
  JsonObject,
  TaskGraph,
  TaskGraphNode,
  ToolDiagnostic,
  ToolSlot,
  UsageState,
} from '@earendil-works/pi-durable'
export type {
  AssistantMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from '@earendil-works/pi-ai'
export { resumed } from './resume.ts'
export { scopeOf } from './scope.ts'

export { Card } from '../app/card.solid.tsx'
/** A card that folds to one quiet line in compact mode; `label` names its button. The reader's choice survives reloads. */
export { Fold, useFold } from '../app/fold.solid.tsx'
export { MessageActions } from '../app/message-actions.solid.tsx'
export { UserText, UserView } from '../app/user-turn.solid.tsx'
export { useToolDuration } from '../app/tool-call.solid.tsx'
/**
 * The values every provider gives for `point`, in discovery order. A provider that throws shows its inline error card
 * in `failures`, an element the caller places, when given.
 */
export { useAllProvided } from './contribution.solid.tsx'
/** The value the last provider in discovery order gives for `point`; `failures` as above. */
export { useProvided } from './contribution.solid.tsx'
/** Building blocks of surfaces; see docs/extensions/surfaces.md. */
export { Header } from '../app/header.solid.tsx'
export { Conversation, Dock, Panels, Sidebar, StatusLine } from '../app/shell.solid.tsx'
/** The prompt box of the scoped or shown conversation alone, without its transcript; wrap it in `ComposerRedirect` to send elsewhere. */
export { Composer } from '../app/composer.solid.tsx'
/** An extension's failure, inline or as a block with a report button, as the shell shows it. */
export { ErrorCard } from '../app/error-card.solid.tsx'
/** A contribution's `icon` (a panel's, a surface's) with `class`. */
export { ContributedIcon } from './contribution.solid.tsx'
/**
 * As a component, renders a registered contribution in its extension's scope. As a type, a slot component, optionally with an `order` (default 0; ties keep folder-name order); in the status line,
 * `phone` keeps the item on the line on a phone, the others move behind its ⋯ popover there.
 */
export { Contribution } from './contribution.solid.tsx'
export { Provided, renderEntry, ScopedConversation, Slot } from './parts.solid.tsx'
