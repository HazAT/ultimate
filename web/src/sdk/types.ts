import type { ComponentType, ReactNode } from 'react'
import type { ImageContent, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'
import type { EntryRecord, InboxItem, JsonObject, ToolDiagnostic } from '@earendil-works/pi-durable'
import type { ConversationSummary } from '../../../shared/protocol.ts'

/** Named places in the shell that extensions fill with components. */
export type SlotName =
  | 'sidebar'
  | 'sidebar.top'
  | 'titlebar.brand'
  | 'titlebar.project'
  | 'titlebar.left'
  | 'titlebar.right'
  | 'header.right'
  | 'statusline.left'
  | 'statusline.right'
  | 'composer.toolbar'
  | 'composer.status'
  | 'composer.actions'
  | 'conversation.overlay'
  | 'transcript.start'
  | 'transcript.end'
  | 'overlay'
  | 'shell.rail'

/**
 * A slot component, optionally with an `order` (default 0; ties keep folder-name order). In the status line, `phone`
 * keeps the item on the line on a phone; the others move behind its ⋯ popover there.
 */
export type Contribution =
  | ComponentType
  | { component: ComponentType; order?: number; phone?: boolean }

/** A tab in the right panel. */
export interface PanelContribution {
  id: string
  title: string
  icon?: ComponentType<{ className?: string }>
  component: ComponentType
  order?: number
  /** `false` keeps the panel out of the tab row until it is opened (`openPanel`, a command); default `true`. */
  tab?: boolean
}

/**
 * A full-screen composition the user switches to: the built-in Agent surface (`extensions/agent`) or an app. Build it
 * from the primitives in `@/sdk` (`Header`, `Conversation`, `Dock`, `StatusLine`, …) and your own components.
 */
export interface SurfaceContribution {
  /** Global id, stored in `shell.surface`; prefix it with the extension name when it is generic. `agent` is the home. */
  id: string
  title: string
  icon: ComponentType<{ className?: string }>
  /** One line for the switcher. */
  description?: string
  /** Position after Agent in the switcher, ⌘K, and `mod+1…9`; lower first (default 0), then by title. */
  order?: number
  component: ComponentType
}

/** One tool call as the transcript sees it: the model's call, live progress, and the result. */
export interface ToolCallView {
  /** Tool call id, shared by the call and its result. */
  id: string
  name: string
  /** Arguments; partial while the model is still streaming them. */
  args: ToolCall['arguments']
  /**
   * `streaming`: the model is still writing the call. `pending`: queued. `running`: executing.
   * `done`/`error`: finished. `interrupted`: the run ended without a result.
   */
  status: 'streaming' | 'pending' | 'running' | 'done' | 'error' | 'interrupted'
  /** Streamed output while running; the result's text once finished. */
  output: string
  /** Images of the result, such as screenshots; `ToolImages` from `@/components/ai/tool` renders them. */
  images: readonly ImageContent[]
  /** Last `details()` while running, the result's details once finished; each tool defines its shape. */
  details?: unknown
  diagnostics: readonly ToolDiagnostic[]
  /** What the output bounds dropped while running. */
  dropped?: { bytes: number; lines: number }
  /** Epoch ms when the call started (its answer ended) and when its result was written; absent when interrupted. */
  startedAt?: number
  endedAt?: number
  result?: ToolResultMessage
}

/** `core` is the rendering so far, starting with the generic tool card. */
export type ToolRenderer = ComponentType<{ call: ToolCallView; core: ReactNode }>
/** A tool call as one short line of plain text, for a folded run's step list; hooks are allowed. */
export type ToolLineRenderer = ComponentType<{ call: ToolCallView }>
/**
 * `core` is the core's rendering of the entry: return it for entries you leave alone, or wrap it. `blocks` are the
 * content blocks of an assistant message a compact row shows, when it shows only some.
 */
export type EntryRenderer = ComponentType<{
  entry: EntryRecord
  core: ReactNode
  blocks?: readonly number[]
}>

/**
 * A link in Markdown (messages, reports): `href` and the link's `children`, and `core`, the rendering so far, starting
 * with the default link that asks before opening in a new tab. Return `core` for links you leave alone.
 */
export type LinkRenderer = ComponentType<{ href: string; children: ReactNode; core: ReactNode }>

/**
 * A fenced code block in Markdown, by its language: `code`, `language`, `incomplete` while the fence still streams, and
 * `core`, the rendering so far, starting with the highlighted block with its copy button.
 */
export type CodeBlockRenderer = ComponentType<{
  code: string
  language: string
  incomplete: boolean
  core: ReactNode
}>

export type InboxRenderer = ComponentType<{ item: InboxItem; core: ReactNode; cancel: ReactNode }>

/** Wraps the shown conversation's composer (`core`); `dock` when it sits in a narrow side region. */
export type ComposerRenderer = ComponentType<{ core: ReactNode; dock?: boolean }>

/**
 * A drag arriving at the composer: what the source handed over, and whether Shift was held. A handler that takes it
 * inserts where it likes; the shell's own handling of a drop is the text it carries, and its images as images.
 */
export interface ComposerDrop {
  /** The payload: the files and the text the drag carries. */
  dataTransfer: DataTransfer
  /** Shift was held, as in a drag that copies the file rather than pointing at it. */
  shiftKey: boolean
}

/** A paste arriving at the composer's editor: its text and its files, as the clipboard has them. */
export interface ComposerPaste {
  /** The clipboard's text, its line endings normalised to `\n`. */
  text: string
  /** The clipboard's files, such as a copied image. */
  files: readonly File[]
}

/**
 * What a handler may do with the composer the event landed in: its draft, its images, its error line, and a place above
 * its editor for what the handler needs the user to answer. Handlers only run for a composer that takes input.
 */
export interface ComposerInput {
  /** The conversation whose draft takes the input. */
  conversationId: number
  /** Insert `text` at the editor's cursor in place of its selection, as typing it would, and focus it. */
  insert(text: string): void
  /** Attach files as images through the composer's own image path, its limits and its errors included. */
  addImages(files: readonly File[]): Promise<void>
  /** Show a message in the composer's own error line, or clear it. */
  setError(message: string | undefined): void
  /** Show a component above the editor instead of what you last showed, `undefined` to clear it. */
  show(ui?: ReactNode): void
}

/**
 * What the composer makes of a drop or a paste before the shell does: return `true` to claim it, so the shell's own
 * handling does not run, or nothing to leave it to the shell. A handler that throws is reported and skipped.
 */
export interface ComposerInputContribution {
  drop?(drop: ComposerDrop, composer: ComposerInput): boolean | void
  paste?(paste: ComposerPaste, composer: ComposerInput): boolean | void
}

/** What a document renderer receives: the shown conversation's document of its kind, live. */
export interface DocumentProps {
  value: Readonly<JsonObject>
  conversationId: number
}
/**
 * How the Documents tab shows one kind of extension document, a server facet's `docs` export (`ultimate.plan`).
 * Kinds without one show as a JSON tree.
 */
export interface DocumentContribution {
  kind: string
  title: string
  icon?: ComponentType<{ className?: string }>
  component: ComponentType<DocumentProps>
}

/** Navigation and shell actions, passed to commands and returned by `useUltimate()`. */
export interface UltimateActions {
  /** `replace` takes the current browser history entry instead of adding one, as a redirect does. */
  switchConversation: (id: number, options?: { replace?: boolean }) => void
  /** Show surface `id` (`agent` is the home); the conversation keeps running. */
  showSurface: (id: string) => void
  /** Open the right panel, on tab `id` when given. */
  openPanel: (id?: string) => void
  closePanel: () => void
  togglePanel: () => void
  toggleSidebar: () => void
  runCommand: (id: string) => void
  /** Open or close a dialog by id; an overlay reads it with `useDialog(id)`. */
  open: (dialog: string) => void
  close: (dialog: string) => void
  openPalette: () => void
  focusComposer: () => void
  /** Switch this browser to the light or dark theme; `getState().ui.theme` is the current one. */
  setTheme: (theme: 'dark' | 'light') => void
}
export interface UltimateContext extends UltimateActions {
  /** The shown conversation, once known. */
  conversationId?: number
  /** A stored message targeted by a contextual command. */
  entryId?: number
  /** The id of the surface on screen: Agent while a chosen surface that failed falls back. */
  surface: string
}

export interface CommandContribution {
  id: string
  title: string
  /** Shortcut: `mod+shift+m`, or a sequence such as `mod+k m` (`mod` is ⌘ on macOS, Ctrl elsewhere). */
  keys?: string
  /** Palette group; defaults to the extension name. */
  group?: string
  /**
   * Fire a plain-key shortcut (`escape`, `shift+tab`) even while the user types in the composer (not in other inputs),
   * though not while a dialog is open.
   */
  whileTyping?: boolean
  /** Hide the command when this returns false. */
  when?(context: UltimateContext): boolean
  /** Return a promise to have its failure reported. */
  run(context: UltimateContext): void | Promise<unknown>
}

/**
 * A conversation that uses compact mode: each run of tool calls and thinking between its inputs, messages and answers folds
 * into one "worked · N steps" row that expands to the usual rendering.
 */
export interface CompactContribution {
  /** Whether a conversation uses compact mode, from its summary and the root documents of `docs`. */
  when: (conversation: ConversationSummary, docs: CompactDocs) => boolean
  /**
   * Calls that stay visible between folded runs, such as the messages it sends: a tool name, or a test of a call, such
   * as a script whose nested calls sent a message.
   */
  tools?: readonly (string | CompactCallTest)[]
  /** Kinds of the root conversation's documents `when` and the tests read; the transcript follows them and passes them in. */
  docs?: readonly string[]
  /**
   * Rows that are background to the conversation, such as traffic between agents: two or more in a row, with the runs of work
   * between them, fold into one line that expands to them. A row is a stored entry with the visible calls it shows.
   */
  quiet?: CompactQuietTest
  /** The line a folded group of quiet rows shows; the first matching facet's wins, a step count otherwise. */
  summary?: ComponentType<CompactSummaryProps>
  /**
   * Rows that are the conversation the reader follows, such as @ultimate's messages to the user: everything between two of
   * them recedes into one faded stretch.
   */
  thread?: (row: CompactRow, docs: CompactDocs) => boolean
}
/** A compact transcript row: an entry, and the visible tool calls it shows when it shows only some of its blocks. */
export interface CompactRow {
  entry: EntryRecord
  calls: readonly ToolCall[]
}
/** Whether a row is background; `hidden` for one that renders nothing, which joins a group without counting. */
export type CompactQuietTest = (row: CompactRow, docs: CompactDocs) => boolean | 'hidden'
export interface CompactSummaryProps {
  /** The group's rows that are no runs of work. */
  rows: readonly CompactRow[]
  /** Steps in its runs of work. */
  steps: number
  /** Whether the agent still works in it. */
  working: boolean
  /** Whether it sums up a whole stretch between thread rows (`thread`), landings and notes included, not one quiet group. */
  between?: boolean
}
/** The root conversation's documents of the contributions' `docs` kinds, by kind, as `useDocOf(1, kind)` reads them. */
export type CompactDocs = Readonly<Record<string, Readonly<JsonObject> | null | undefined>>
export type CompactCallTest = (call: ToolCall, docs: CompactDocs) => boolean

/**
 * What an empty conversation says it is, and its composer's placeholder, for matching conversations; the last matching
 * facet wins. The core's own wording applies otherwise.
 */
export interface IntroContribution {
  when: (conversation: ConversationSummary) => boolean
  title: string
  hint?: string
  placeholder?: string
  /** Shown under the empty state, such as a setup card the conversation needs first. */
  card?: ComponentType
}

/**
 * A value one extension's browser code asks for and another provides: the web's extension point. The asking extension
 * declares it in its `ui.tsx` as `definePoint<Input, Value>('<owner>.<point>')` and renders `<Provided point input>`;
 * a higher extension imports it and lists `provide(Point, useValue)` under `provides`. Dependencies keep pointing at
 * the owner, as with a server extension point.
 */
export interface Point<Input, Value> {
  readonly point: string
  /** Phantom: carries the input type; never set at runtime. */
  readonly input?: Input
  /** Phantom: carries the value type; never set at runtime. */
  readonly value?: Value
}
export const definePoint = <Input, Value>(point: string): Point<Input, Value> => ({ point })
/**
 * The conversations whose run a pause of the host parked (the optional `pause` extension provides it): their work is
 * held, none of it executes, so the transcript and every list of conversations show them paused, not working.
 * Undefined, as none, while nothing provides it.
 */
export const ParkedRuns = definePoint<null, ReadonlySet<number>>('ultimate.parked')
/**
 * When a run's task first ran, in epoch ms, by its task ID (the `tasks` extension provides it), for the working
 * indicator's clock. Undefined while unknown or while nothing provides it.
 */
export const RunStart = definePoint<number | undefined, number | undefined>('ultimate.runStart')
/**
 * What the title bar names a conversation's kind before its title (`messages` provides it: `branch · coordinator` for
 * the branches it starts); undefined shows the conversation's label as it is.
 */
export const ConversationKind = definePoint<ConversationSummary | undefined, string | undefined>(
  'ultimate.conversationKind',
)
/**
 * The text another conversation can follow to read message `id` of `conversation` (`codemode` provides it); a stored
 * message offers to copy it. No copy action while nothing provides it.
 */
export const MessageReference = definePoint<
  { conversation: number; id: number },
  string | undefined
>('ultimate.messageReference')

/**
 * Where an error card can hand its report for debugging (`subagents` provides it: into @ultimate's composer, unsent):
 * `title` labels the card's button. No button while nothing provides it.
 */
export const ErrorReport = definePoint<
  null,
  { title: string; send: (report: string) => void } | undefined
>('ultimate.errorReport')

/** What a facet provides for a point: `useValue` is a hook, run once per `<Provided>` with its input. */
export interface Provision {
  point: string
  use: (input: never) => unknown
}
export const provide = <Input, Value>(
  point: Point<Input, Value>,
  useValue: (input: Input) => Value,
): Provision => ({ point: point.point, use: useValue })

/** The browser facet of an extension: `extensions/<name>/web.tsx` default-exports one. */
export interface WebExtension {
  slots?: Partial<Record<SlotName, Contribution | readonly Contribution[]>>
  panels?: readonly PanelContribution[]
  surfaces?: readonly SurfaceContribution[]
  /** Tool-call renderers by tool name. */
  tools?: Readonly<Record<string, ToolRenderer>>
  /** One-line step texts by tool name, for the compact transcript's folded work rows; the last facet providing a name wins. */
  toolLines?: Readonly<Record<string, ToolLineRenderer>>
  /** Entry renderers by entry kind; they also replace the core renderer of a `pi.*` kind. */
  entries?: Readonly<Record<string, EntryRenderer>>
  inbox?: InboxRenderer
  /** Wraps the shown conversation's composer; facets compose in discovery order, each receiving the previous core. */
  composer?: ComposerRenderer
  /**
   * Takes drops and pastes before the composer's own handling; handlers run in discovery order, and the first to claim
   * an event takes it.
   */
  composerInput?: readonly ComposerInputContribution[]
  /** Renders links in Markdown; renderers compose in discovery order, each wrapping the one before it. */
  link?: LinkRenderer
  /** Fenced code block renderers by language; they compose in discovery order, each wrapping the one before it. */
  codeBlocks?: Readonly<Record<string, CodeBlockRenderer>>
  /** Contributions to the hover action row on stored messages, in discovery order. */
  messageActions?: readonly ComponentType<{ entry: EntryRecord }>[]
  /** Readouts on the hover action row on stored messages, before its time, in discovery order. */
  messageDetails?: readonly ComponentType<{ entry: EntryRecord }>[]
  /** Inline labels after the Final answer heading on stored assistant messages. */
  answerLabels?: readonly ComponentType<{ entry: EntryRecord }>[]
  /** Overlays on the user's bubble, rendered after it inside a positioned box exactly its size (`absolute inset-0`). */
  userBubble?: readonly ComponentType<{ entry: EntryRecord }>[]
  /** Shows matching conversations in compact mode; the visible tools of every matching facet combine. */
  compact?: CompactContribution
  /** The empty state's wording and the composer's placeholder for matching conversations. */
  intro?: IntroContribution
  /** Document renderers; a later facet wins a kind. */
  documents?: readonly DocumentContribution[]
  commands?: readonly CommandContribution[]
  /** Values for other extensions' points; the last facet in discovery order providing a point wins. */
  provides?: readonly Provision[]
}

export function defineWebExtension(extension: WebExtension): WebExtension {
  return extension
}

const marked = new WeakSet<object>()
/**
 * Marks an entry or tool renderer as one that asks the user to act or decide, such as a Fall asleep card: in a compact
 * transcript its rows never fold away, and the stretch around them splits. Register it wrapped:
 * `entries: { 'my.kind': attention(MyCard) }`. The card shows it is still open with `<Card attention>`.
 */
export function attention<T extends EntryRenderer | ToolRenderer>(renderer: T): T {
  marked.add(renderer)
  return renderer
}
export const needsAttention = (renderer: object | undefined) => !!renderer && marked.has(renderer)
