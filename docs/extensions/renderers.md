# Renderers: tools, entries, links, messages, composer

Part of the [extension guide](../../extensions/README.md). Renderers change how the transcript and the composer show
things. Most receive `core`, the rendering so far, and compose in discovery order (built-in → user → project), each
behind an error boundary that falls back to `core`.

## Tool renderers

How a tool call looks in the transcript, by tool name. Without one, a generic card shows name, arguments, and output.

```tsx
import { Tool, ToolContent, ToolHeader, ToolOutput } from '@/components/ai/tool'
import type { ToolCallView } from '@/sdk'

function Grep({ call }: { call: ToolCallView }) {
  return (
    <Tool>
      <ToolHeader name="grep" state={call.status} title={String(call.args.pattern ?? '')} />
      <ToolContent>
        <ToolOutput output={call.output} isError={call.status === 'error'} />
      </ToolContent>
    </Tool>
  )
}
tools: {
  grep: Grep
}
```

`ToolCallView`: `id`, `name`, `args` (partial while the model streams them), `status` (`streaming`, `pending`,
`running`, `done`, `error`, `interrupted`), `output` (streamed while running, the result's text when done), `images`
(the result's images, such as screenshots), `details` (the tool's `details()`; cast to its shape), `diagnostics`,
`dropped`, `startedAt`/`endedAt`, and `result`. `useToolDuration(call)` gives a ticking duration. `ToolImages` (or one
`ToolImage`) from `@/components/ai/tool` shows images as thumbnails that open full size; the generic card already does.
To put a button beside the header (such as "open"), wrap `ToolHeader` in a flex row inside `Tool`: a button inside the
header would toggle it.

Tool renderers also receive `core`, starting with the generic tool card. Like entry renderers, they compose in
discovery order (built-in → user → project): each receives the previous rendering, and its error boundary falls back
to that rendering. Return `core` to leave it unchanged, wrap it to decorate it, or replace it with your own card.

## Link renderers

`link` renders the links in Markdown that `MessageResponse` shows (messages, reports). It receives `{ href, children,
core }`; `core` starts as Streamdown's link, which asks "Open external link?" before opening a new tab. Like tool
renderers, link renderers compose in discovery order behind error boundaries that fall back to `core`: return `core`
for links you leave alone. A link still streaming never reaches them. `instance` renders links to its previews as chips
that open in the window. `MessageResponse` also turns `#id` and `#id/entry` mentions (three or more digits, outside
code and links) into `#conversation-<id>[-<entry>]` links, and `MentionText` does the same for plain text;
`conversations` renders those of known conversations as their feature chip, others stay text.

```tsx
link: ({ href, children, core }) =>
  href.startsWith('https://docs.example.com/') ? <a href={href}>{children}</a> : core
```

## Inline code renderers

`inlineCode` renders the inline code spans in Markdown that `MessageResponse` shows; fenced blocks never reach it. It
receives `{ code, core }`, where `code` is the span's text and `core` starts as the default `<code>`. They compose like
link renderers: return `core` for spans you leave alone. For example, an extension can make file paths clickable:

```tsx
inlineCode: ({ code, core }) =>
  code.startsWith('src/') ? <button onClick={() => open(code)}>{core}</button> : core
```

## Code block renderers

`codeBlocks` renders the fenced code blocks of one language in Markdown that `MessageResponse` shows, keyed by the
fence's language. Each receives `{ code, language, incomplete, core }`; `core` starts as the highlighted block with its
copy button, and `incomplete` is true while the fence still streams. They compose in discovery order behind error
boundaries that fall back to `core`. Return `core` while `incomplete`, so a half-written block never renders.

```tsx
codeBlocks: {
  dot: ({ code, incomplete, core }) => (incomplete ? core : <Graph source={code} />),
}
```

## Message actions

`messageActions` contributes components to the hover action row on stored user and assistant messages, between the
copy-message and copy-reference buttons. Each receives `{ entry }`, follows discovery order (then array order), and
runs in its own error boundary. Return `null` for messages you do not act on. Keep buttons compact and give them an
accessible label and a tooltip.

```tsx
messageActions: [
  ({ entry }) => (
    <button
      aria-label="Pin message"
      title="Pin message"
      onClick={() => pin(entry.id)}
      type="button"
    >
      <PinIcon className="size-3" />
    </button>
  ),
]
```

`messageDetails` contributes readouts to the same row, before the message's time, under the same rules. `status-line`
shows each message's context and cost there.

`answerLabels` contributes inline labels after the **Final answer** heading, only on stored final assistant messages
(not streaming updates). Like `messageDetails`, it is an array of components receiving `{ entry: EntryRecord }`,
rendered in discovery and contribution order, each behind an extension boundary. Return `null` when the entry has
no relevant label. Keep labels brief and muted; the header wraps at narrow widths. Messages uses it to show where an
answer was sent, or that a one-way message's answer was not sent.

`userBubble` contributes overlays on the user's own bubble: components receiving `{ entry }`, rendered after the
bubble inside a positioned box exactly its size, so an `absolute inset-0` element decorates it. Return `null` when
there is nothing to show. Recall uses it for the light running around a message's border while it checks it.

`toolLines` maps tool names to components receiving `{ call: ToolCallView }` that render the call as one short line
of plain text. A folded "worked · N steps" row lists its newest calls this way under its header (a status icon and the
line, the tool name when no facet provides one); the last facet providing a name wins. Coding tools give their verb and
path or programs, codemode its one-line summary.

`compact` makes conversations use compact mode: `{ when(conversation, docs), tools? }` decides from a conversation's
summary and the root conversation's documents, and in a matching transcript each run of tool calls and thinking
between inputs, messages and answers folds into one quiet "worked · N steps" row that expands to the usual rendering.
Calls the listed `tools` keep stay visible and split the run: a tool name, or a test `(call, docs) => boolean` of a
call; `docs` lists the kinds of the root conversation's documents `when` and the tests read, which the transcript
follows and passes to them by kind. The tools of every matching facet combine. Renderers check `useCompact()`, that
test for the shown conversation or `undefined`, to adapt to it. Messages turns it on for @ultimate's conversation, found
by the standing agents' index (`StandingDoc`) rather than its title, keeping messages, branch starts,
workspace outcomes and scripts its log says messaged you, and shows its messages to you as bubbles. Revealing an entry
in a folded run opens the run. `thread: (row, docs) => boolean` names the rows the reader follows; everything between two
of them recedes into one line that opens it, worded by the first matching facet's `summary` component (`rows`, `steps`,
`working`), an update count otherwise. Messages marks your inputs and @ultimate's messages to you as thread.

## Entry renderers

How an entry kind looks in the transcript. Extensions that append their own entries render them here; a renderer for a
`pi.*` kind takes over from the core one. Unknown kinds show as JSON.

```tsx
entries: { 'notes.pinned': ({ entry }) => <div className="text-muted-foreground">📌 {String(entry.data)}</div> }
```

A renderer also gets `core`, the rendering of the same entry so far: return it for the entries you leave alone, wrap
it, or return `null` to hide the entry. In compact mode, a row can show only some content blocks of a response; `blocks`
lists their indexes then. Several extensions can render one kind: they compose in discovery order, each
receiving the rendering of the one before it as `core`, down to the core's own. Each runs in its own error boundary,
which falls back to its `core` when it throws. `self` renders `pi.system` entries that change the build section as a
reload marker and returns `core` for the rest; `subagents` and `workspaces` both render `pi.user`, each only the inputs
it owns (agent messages, lander reports).

Entry renderers and message contributions relate an entry to its neighbours with `useTranscript()`: the entries the
transcript has loaded, oldest first, which grows as the reader pages in earlier history. `models` marks a response that
ran on another model or thinking level than the one before it this way.

## Inbox renderers

An optional `inbox` renderer wraps each queued composer input with `{ item, core, cancel }`. Return `core` for inputs you do not own; when replacing it, include `cancel` to retain core cancellation. Like entry renderers, the last facet in discovery order wins and runs behind an extension boundary with core fallback. Keep provenance and domain-specific UI in the extension.

## Composer renderers

An optional `composer` renderer receives `{ core, dock? }` for the shown conversation's composer (`dock` marks a
narrow side region). Render `core` to preserve the existing composer, optionally wrapping it. Facets compose in
discovery order: each receives the previous rendering as `core`, behind its own extension boundary with that rendering
as fallback. These renderers can use `useTranscript()` for the shown conversation's current entries.
Lineage uses this to show a root's read-only History banner, with the way back to @ultimate, instead of a composer.
To send what the composer submits elsewhere, wrap `core` in `<ComposerRedirect to={{ placeholder, send }}>` (from `@/sdk`):
while `to` is set, Enter and the send button call `send(text)` instead of submitting, with the same draft, error and
sending states (side-chat forks @ultimate this way). A redirect also sets aside images, `composer.actions` and steer
and queue; to only change what the box says, provide `ComposerPlaceholder` instead:
`provide(ComposerPlaceholder, ({ conversation, busy }) => (conversation === mine ? 'Ask the coach…' : undefined))`.
Only the shown conversation's composer takes typing shortcuts
(Escape, Shift+Tab); a scoped one does not.
`switchConversation(id, { replace: true })` takes the current history entry instead of adding one, as a redirect does.
