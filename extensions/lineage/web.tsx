import {
  ArrowLeftIcon,
  BrainIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CodeIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  GitForkIcon,
  ScrollTextIcon,
  SearchIcon,
  StickyNoteIcon,
  SunriseIcon,
  Trash2Icon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { MentionText, MessageResponse } from '@/components/ai/message'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  api,
  Card,
  cn,
  defineWebExtension,
  events,
  errorMessage,
  Fold,
  provide,
  Provided,
  formatAgo,
  formatKeys,
  formatTime,
  formatTokens,
  Header,
  Sidebar,
  StatusLine,
  useConversation,
  useDocOf,
  useNow,
  useTranscript,
  useUiState,
  useUltimate,
} from '@/sdk'
import type { EntryRecord, ToolCallView } from '@/sdk'
import { store } from '@/sdk/client'
import { ConversationRef, Unsummarized } from '../conversations/ui.tsx'
import { talkToUltimate } from '../subagents/ui.tsx'
import { Open, useGithubRepo } from '../workspaces/ui.tsx'
import { ForgetAction, MemoryDoc, OpenEditorAction, TallyDoc } from './refs.ts'
import type { MemoryItem } from './refs.ts'
import { column, MEMORY_FOCUS, MEMORY_SURFACE, MemoryHeader, useRoots } from './ui.tsx'
import { MemoryCall, NotifyCall, RememberCall } from './calls.tsx'
import { GoBackAction, Rewound, RewoundDependent } from './rewind.tsx'

function userText(entry: EntryRecord) {
  const message = entry.model?.[0]
  if (message?.role !== 'user') return ''
  return typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}

/** A branch started from this conversation: in its tree's root a card with its intent, elsewhere a quiet divider. */
function Branched({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  const { branch, intent } = entry.data as { branch: number; intent: string }
  if (entry.model) return <Started entry={entry} />
  return (
    <button
      className="flex w-full min-w-0 cursor-pointer items-center gap-3 font-mono text-[0.6875rem] text-muted-foreground before:h-px before:flex-1 before:bg-border/70 after:h-px after:flex-1 after:bg-border/70 hover:text-foreground"
      data-lineage-branched={branch}
      onClick={() => switchConversation(branch)}
      title={`Open #${branch}`}
      type="button"
    >
      <span className="flex max-w-[70%] min-w-0 items-center gap-1.5">
        <GitForkIcon className="size-3 shrink-0" />
        <span className="shrink-0">Branched →</span>
        <ConversationRef id={branch} title={intent} />
      </span>
    </button>
  )
}

/** The wake-up after a manual compaction of @ultimate: a quiet divider, not a user bubble. */
function Woken() {
  return (
    <div
      className="flex items-center gap-3 font-mono text-[0.6875rem] text-muted-foreground before:h-px before:flex-1 before:bg-border/70 after:h-px after:flex-1 after:bg-border/70"
      data-lineage-woken
    >
      <span className="flex items-center gap-1.5">
        <SunriseIcon className="size-3 shrink-0" />
        woke after compaction
      </span>
    </div>
  )
}

/** The tally's branch node: which branch started, from where, with what intent (older nodes carry the whole prompt). */
function Started({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  const { branch, at, intent, images, from } = entry.data as {
    branch: number
    at: number
    intent: string
    images?: number
    from?: number
  }
  const [open, setOpen] = useState(false)
  const timestamp = entry.model?.[0]?.timestamp
  return (
    <Card data-lineage-started={branch}>
      <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[0.6875rem] text-muted-foreground">
        <GitForkIcon className="size-3.5 shrink-0 text-brand" />
        <span className="shrink-0 text-foreground">Started</span>
        <button
          className="flex min-w-0 cursor-pointer overflow-hidden text-foreground hover:underline"
          onClick={() => switchConversation(branch)}
          title={`Open #${branch}`}
          type="button"
        >
          <ConversationRef id={branch} />
        </button>
        {from !== undefined && (
          <button
            className="shrink-0 cursor-pointer hover:text-foreground hover:underline"
            onClick={() => switchConversation(from)}
            title={`Open #${from}`}
            type="button"
          >
            from #{from}/{at}
          </button>
        )}
        {timestamp !== undefined && (
          <time
            className="ml-auto shrink-0 tabular-nums"
            dateTime={new Date(timestamp).toISOString()}
            title={new Date(timestamp).toLocaleString()}
          >
            {formatTime(new Date(timestamp))}
          </time>
        )}
      </header>
      <button
        aria-expanded={open}
        className="block w-full min-w-0 cursor-pointer px-3 py-2.5 text-left text-[0.8125rem] leading-relaxed"
        onClick={() => setOpen((current) => !current)}
        title={open ? 'Show less' : 'Show more'}
        type="button"
      >
        <span className={cn('block break-words whitespace-pre-wrap', !open && 'line-clamp-3')}>
          <MentionText text={intent} />
        </span>
        {!!images && (
          <span className="mt-1.5 block font-mono text-[0.6875rem] text-muted-foreground">
            {images} image{images === 1 ? '' : 's'}
          </span>
        )}
      </button>
    </Card>
  )
}

type AbstractData = {
  conversation: number
  at: number
  text: string
  title?: string
  anchor?: number
}

/**
 * A conversation's abstract at its anchor, with the text of the newest carrier that replaced it; carriers show nothing.
 * Once a landing froze it (or, in older tallies, a later abstract superseded it), it is not shown.
 */
function Abstract({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  const transcript = useTranscript()
  if ((entry.data as AbstractData).anchor !== undefined) return null
  let latest = entry
  for (const other of transcript)
    if (other.id > latest.id && other.edits?.some((edit) => edit.target === entry.id))
      latest = other
  const omitted = latest.edits?.some((edit) => edit.target === entry.id && edit.action === 'omit')
  if (omitted) return null
  const { conversation, at, text, title } = latest.data as AbstractData
  return (
    <Fold
      card={entry.id}
      summary={
        <>
          <ScrollTextIcon className="size-3 shrink-0" />
          <span className="shrink-0">Abstract</span>
          <span className="flex min-w-0 text-foreground/80">
            <ConversationRef id={conversation} title={title} />
          </span>
        </>
      }
    >
      <section
        className="min-w-0 rounded-md border border-border bg-muted/20"
        data-lineage-abstract={conversation}
      >
        <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-1.5 font-mono text-[0.6875rem] text-muted-foreground">
          <ScrollTextIcon className="size-3.5 shrink-0" />
          <span className="shrink-0">Abstract ·</span>
          <button
            className="flex min-w-0 cursor-pointer text-foreground hover:underline"
            onClick={() => switchConversation(conversation)}
            title={`Open #${conversation}`}
            type="button"
          >
            <ConversationRef id={conversation} title={title} />
          </button>
          <Open className="ml-auto" entry={at} id={conversation} />
        </header>
        <p className="min-w-0 px-3 py-2.5 text-[0.7812rem] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
          <MentionText text={text} />
        </p>
      </section>
    </Fold>
  )
}

/** A conversation this one asked `notify` about has finished: its title and last answer. */
function Finished({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  const { from, title, text } = entry.data as { from: number; title?: string; text: string }
  return (
    <section
      className="min-w-0 rounded-md border border-l-2 border-border border-l-success/70 bg-muted/20"
      data-lineage-finished={from}
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[0.6875rem] text-muted-foreground">
        <CircleCheckIcon className="size-3.5 shrink-0 text-success" />
        <button
          className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left text-foreground hover:underline"
          onClick={() => switchConversation(from)}
          title={`Open #${from}`}
          type="button"
        >
          <ConversationRef id={from} title={title} />
          <span className="shrink-0">finished</span>
        </button>
      </header>
      <div className="min-w-0 px-3 py-2.5 text-[0.8125rem] leading-relaxed">
        <MessageResponse>{text}</MessageResponse>
      </div>
    </section>
  )
}

/** A note between conversations, tinted yellow: as received (`Note from #N`) and as left (`Note → #N`). */
function NoteCard({
  label,
  id,
  text,
  note,
}: {
  label: string
  id?: number | string
  text: string
  note: 'received' | 'left'
}) {
  const { switchConversation } = useUltimate()
  return (
    <section
      className="min-w-0 rounded-md border border-l-2 border-note/25 border-l-note/60 bg-note/6"
      data-lineage-note={note}
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-note/15 px-3 py-2 font-mono text-[0.6875rem] text-foreground">
        <StickyNoteIcon className="size-3.5 shrink-0 text-note" />
        {label}
        {typeof id === 'number' ? (
          <button
            className="min-w-0 cursor-pointer hover:underline"
            onClick={() => switchConversation(id)}
            title={`Open #${id}`}
            type="button"
          >
            <ConversationRef id={id} />
          </button>
        ) : (
          id
        )}
      </header>
      <div className="min-w-0 px-3 py-2.5 text-[0.8125rem] leading-relaxed">
        <MessageResponse>{text}</MessageResponse>
      </div>
    </section>
  )
}

/** A note another conversation (or the lander, a quiet `notify`, a catch-up on the tally and main) left here. */
function Note({ entry, core }: { entry: EntryRecord; core: React.ReactNode }) {
  const { from, text, source } = entry.data as {
    from?: number
    text: string
    source?: 'lander' | 'finished' | 'main'
  }
  if (source === 'lander') return core
  if (source === 'finished') return <Finished entry={entry} />
  if (source === 'main') return <Catchup text={text} />
  return <NoteCard id={from} label="Note from" note="received" text={text} />
}

/** A catch-up on the tally and main. */
function Catchup({ text }: { text: string }) {
  return (
    <Card data-lineage-note="main">
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[0.6875rem] text-foreground">
        <GitBranchIcon className="size-3.5 text-brand" />
        Catch-up
      </header>
      <div className="min-w-0 px-3 py-2.5 text-[0.8125rem] leading-relaxed">
        <MessageResponse>{text}</MessageResponse>
      </div>
    </Card>
  )
}

/** The `note` tool as the note it left; a failed call keeps the generic card with its error. */
function NoteCall({ call, core }: { call: ToolCallView; core: ReactNode }) {
  if (call.status === 'error' || call.status === 'interrupted') return core
  const left = /^Left a note in #(\d+)\.$/.exec(call.output)
  const to = left ? Number(left[1]) : call.args.to
  return (
    <NoteCard
      id={typeof to === 'number' ? to : typeof to === 'string' ? to : undefined}
      label="Note →"
      note="left"
      text={typeof call.args.text === 'string' ? call.args.text : ''}
    />
  )
}

/** A conversation's history distilled into the start of its tally. */
function Genesis({ entry }: { entry: EntryRecord }) {
  const text = userText(entry)
  const from = /^<tally from="#(\d+)\/(\d+)">/.exec(text)
  const source = from ? Number(from[1]) : undefined
  const genesis = text.replace(/^<tally[^>]*>\n/, '').replace(/\n<\/tally>$/, '')
  return (
    <Collapsible
      className="group/genesis rounded-lg border border-brand/30 bg-brand/5"
      data-lineage-genesis={entry.conversationId}
    >
      <CollapsibleTrigger className="flex w-full cursor-pointer flex-col gap-1 px-3.5 py-2.5 text-left">
        <span className="flex items-center gap-1.5 font-mono text-[0.6875rem] text-brand">
          <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]/genesis:rotate-90" />
          Context starts here{from ? ` · distilled from #${from[1]}/${from[2]}` : ''}
        </span>
        <span className="text-xs text-muted-foreground">
          {source !== undefined && source !== entry.conversationId
            ? 'The project reading is distilled into the start of this context.'
            : 'The conversation before this point is distilled into the start of the context. Earlier messages remain available above.'}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-brand/20 px-3.5 py-2.5 text-[0.8125rem]">
        {from && <Open id={Number(from[1])} entry={Number(from[2])} />}
        <MessageResponse>{genesis}</MessageResponse>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** A tally's genesis, or the empty reset a new tally starts with, which shows nothing. */
function Reset({ entry, core }: { entry: EntryRecord; core: ReactNode }) {
  const roots = useRoots()
  const lineage = (entry.data as { lineage?: { tally?: true } } | undefined)?.lineage
  if (lineage?.tally) return <Genesis entry={entry} />
  if (!entry.model && entry.data === undefined && roots?.includes(entry.conversationId)) return null
  return core
}

/** A root is the project's history: read-only, with the way back to @ultimate in place of its composer. */
function RootComposer({ core, dock }: { core: ReactNode; dock?: boolean }) {
  const id = useConversation((conversation) => conversation.id)
  const roots = useRoots()
  if (id === undefined || !roots?.includes(id)) return core
  return <HistoryBanner dock={dock} id={id} />
}

function HistoryBanner({ id, dock }: { id: number; dock?: boolean }) {
  const actions = useUltimate()
  const github = useGithubRepo()
  return (
    <div className={cn(column(dock), 'pb-3')}>
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-2.5 rounded-lg border border-border/70 border-l-2 border-l-brand/50 bg-muted/30 px-3.5 py-3"
        data-lineage-history={id}
      >
        <ScrollTextIcon className="size-4 shrink-0 text-brand" />
        <div className="min-w-56 flex-1">
          <p className="text-[0.8438rem] font-medium text-foreground">
            You're reading the project's history
          </p>
          <p className="text-[0.7812rem] leading-snug text-muted-foreground">
            Every branch, abstract and landing so far, read-only. To change anything, talk to
            @ultimate.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {/* Zed opens on the machine Ultimate runs on, so a phone gets only the GitHub link. */}
          <Button
            className="pointer-coarse:hidden"
            onClick={() =>
              void api
                .action(OpenEditorAction)
                .catch((error: unknown) =>
                  store.notify({ level: 'error', message: errorMessage(error) }),
                )
            }
            title="Open the project folder in Zed, on the machine Ultimate runs on"
            variant="ghost"
          >
            <CodeIcon />
            Open in Zed
          </Button>
          {github && (
            <Button asChild size="icon" variant="ghost">
              <a
                aria-label="Open on GitHub"
                href={`https://${github}`}
                rel="noreferrer"
                target="_blank"
                title={`The code as it landed, on ${github}`}
              >
                <ExternalLinkIcon />
              </a>
            </Button>
          )}
          <Button onClick={() => void talkToUltimate(actions)}>
            <ArrowLeftIcon />
            Back to @ultimate
            <KbdGroup className="hidden sm:inline-flex pointer-coarse:hidden">
              {formatKeys('mod+0')[0].map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </KbdGroup>
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Where a memory was learned, `#conversation/entry`, as that conversation's chip; a click opens it at the entry. */
function MemorySource({ source }: { source: string }) {
  const { switchConversation, showSurface } = useUltimate()
  const [conversation, entry] = source.slice(1).split('/').map(Number)
  return (
    <p className="mt-1 flex min-w-0 items-center gap-1 font-mono text-[0.6562rem] text-muted-foreground">
      <span className="shrink-0">learned in</span>
      <button
        className="flex min-w-0 cursor-pointer items-center rounded-sm px-0.5 text-[0.6875rem] text-foreground hover:bg-accent"
        data-memory-source={source}
        onClick={() => {
          if (entry !== undefined) events.emit('messages:open', { conversation, entry })
          showSurface('agent')
          switchConversation(conversation)
        }}
        title={`Open ${source}`}
        type="button"
      >
        <ConversationRef className="gap-1" id={conversation} />
        {entry !== undefined && <span className="shrink-0 text-muted-foreground">/{entry}</span>}
      </button>
    </p>
  )
}

/** One memory under its kind's heading: slug, line and age; a click shows its body and source. The trash icon forgets it. */
function MemoryRow({
  root,
  slug,
  item,
  now,
}: {
  root: number
  slug: string
  item: MemoryItem
  now: number
}) {
  const [open, setOpen] = useState(false)
  const [forgetting, setForgetting] = useState(false)
  // A recall chip asks for this memory: unfold it, bring it into view, and take the request.
  const [focus, setFocus] = useUiState<string | null>(MEMORY_FOCUS, null)
  const row = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (focus !== slug) return
    setOpen(true)
    row.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setFocus(null)
  }, [focus, slug, setFocus])
  return (
    <li className="group/memory min-w-0 rounded-md hover:bg-muted/40" data-memory={slug} ref={row}>
      <div className="flex min-w-0 items-start">
        <button
          aria-expanded={open}
          className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => setOpen((current) => !current)}
          title={open ? 'Show less' : 'Show the memory'}
          type="button"
        >
          <span className="flex w-full min-w-0 items-center gap-1.5 font-mono text-[0.6562rem] leading-4 text-muted-foreground">
            <span className="min-w-0 truncate">{slug}</span>
            <span
              className="ml-auto shrink-0 pl-1 text-muted-foreground"
              title={new Date(item.updated).toLocaleString()}
            >
              {formatAgo(item.updated, now)}
            </span>
          </span>
          <span
            className={cn(
              'block text-[0.8125rem] leading-snug break-words text-foreground/90',
              !open && 'line-clamp-2',
            )}
          >
            {item.line}
          </span>
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={`Forget ${slug}`}
              className="invisible mt-1.5 mr-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none group-focus-within/memory:visible group-hover/memory:visible pointer-coarse:visible hover:bg-muted hover:text-error focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              disabled={forgetting}
              onClick={() => {
                setForgetting(true)
                void api
                  .action(ForgetAction, { root, slug })
                  .catch((error: unknown) =>
                    store.notify({ level: 'error', message: errorMessage(error) }),
                  )
                  .finally(() => setForgetting(false))
              }}
              type="button"
            >
              <Trash2Icon className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="font-mono text-[0.6875rem]" side="left">
            Forget this memory
          </TooltipContent>
        </Tooltip>
      </div>
      {open && (
        <div className="min-w-0 px-2 pb-3">
          <div className="min-w-0 text-[0.8125rem] leading-relaxed text-muted-foreground">
            <MessageResponse>{item.body}</MessageResponse>
          </div>
          {item.source && <MemorySource source={item.source} />}
        </div>
      )}
    </li>
  )
}

const kindSections = [
  ['decision', 'Decisions'],
  ['fact', 'Facts'],
  ['lesson', 'Lessons'],
] as const

/**
 * The Memory surface: each root's project memory, what every new branch starts from, in a reading column beside the
 * sidebar, grouped into decisions, facts and lessons, newest first. A row unfolds its body and source; @ultimate
 * maintains it. The filter narrows every group to the memories whose slug, line or body contain its text.
 */
function MemorySurface() {
  const roots = useRoots() ?? []
  const [filter, setFilter] = useState('')
  return (
    <>
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <Header>
            <span className="flex shrink-0 items-center gap-2 text-[0.8125rem] font-medium">
              <BrainIcon className="size-4 text-muted-foreground" />
              Memory
            </span>
          </Header>
          <div className="min-h-0 flex-1 overflow-y-auto" data-lineage-memory-surface>
            <div className={cn(column(), 'pt-4 pb-10')}>
              {/* The header pads itself for a panel; in the column it aligns with the rows' edges. */}
              <div className="[&>*]:px-0">
                <Provided input={null} point={MemoryHeader}>
                  {(header) => header}
                </Provided>
              </div>
              {roots.map((root) => (
                <RootMemory
                  filter={filter}
                  key={root}
                  label={roots.length > 1}
                  root={root}
                  setFilter={root === roots[0] ? setFilter : undefined}
                />
              ))}
            </div>
          </div>
        </main>
      </div>
      <StatusLine />
    </>
  )
}

function RootMemory({
  root,
  label,
  filter,
  setFilter,
}: {
  root: number
  label: boolean
  filter: string
  /** The filter box shows above the first root's memories only, and filters every root. */
  setFilter?: (text: string) => void
}) {
  const needle = filter.trim().toLowerCase()
  const memories = useDocOf(root, MemoryDoc)?.memories ?? {}
  const tally = useDocOf(root, TallyDoc)
  const now = useNow(60_000)
  const slugs = Object.keys(memories).toSorted(
    (a, b) => memories[b].updated - memories[a].updated || a.localeCompare(b),
  )
  const matches = slugs.filter(
    (slug) =>
      !needle ||
      [slug, memories[slug].line, memories[slug].body].some((text) =>
        text.toLowerCase().includes(needle),
      ),
  )
  return (
    <section data-lineage-memory={root}>
      {label && <p className="pt-4 font-mono text-[0.6875rem] text-foreground">#{root}</p>}
      {slugs.length === 0 ? (
        <p className="py-8 text-[0.7812rem] text-muted-foreground">
          No memories yet. @ultimate keeps decisions, facts and lessons here as branches land.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-3">
            <p className="min-w-0 font-mono text-[0.6562rem] text-muted-foreground">
              {needle ? `${matches.length} of ${slugs.length}` : slugs.length} memories
              {tally?.briefTokens !== undefined && (
                <span title="Tokens every new branch starts from">
                  {' · '}
                  {formatTokens(tally.briefTokens)} tokens
                </span>
              )}
            </p>
            {setFilter && (
              <label className="ml-auto flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-border/70 px-2 focus-within:border-ring max-sm:w-full sm:w-56">
                <SearchIcon className="size-3 shrink-0 text-muted-foreground" />
                <input
                  aria-label="Filter memories"
                  className="min-w-0 flex-1 bg-transparent font-mono text-[0.6875rem] outline-none placeholder:text-muted-foreground"
                  onChange={(event) => setFilter(event.target.value)}
                  onKeyDown={(event) => event.key === 'Escape' && setFilter('')}
                  placeholder="filter"
                  value={filter}
                />
              </label>
            )}
          </div>
          {matches.length === 0 && (
            <p className="py-8 font-mono text-[0.7188rem] text-muted-foreground">
              No memory mentions “{filter.trim()}”.
            </p>
          )}
          {kindSections.map(([kind, title]) => {
            const shown = matches.filter((slug) => memories[slug].kind === kind)
            if (!shown.length) return null
            return (
              <div className="mt-6" data-memory-kind={kind} key={kind}>
                <h3 className="flex items-center gap-1.5 border-b border-border/60 pb-1.5 section-label">
                  <span className={cn('size-1.5 rounded-full', kindDots[kind])} />
                  {title}
                  <span className="text-muted-foreground">{shown.length}</span>
                </h3>
                <ul className="-mx-2 flex flex-col pt-1">
                  {shown.map((slug) => (
                    <MemoryRow item={memories[slug]} key={slug} now={now} root={root} slug={slug} />
                  ))}
                </ul>
              </div>
            )
          })}
        </>
      )}
    </section>
  )
}

const kindDots: Record<MemoryItem['kind'], string> = {
  decision: 'bg-brand',
  fact: 'bg-muted-foreground/60',
  lesson: 'bg-amber-500',
}

/** Keeps the roots streaming for synchronous readers, such as the `when` of the agent's Compact command. */
function Roots() {
  useRoots()
  return null
}

export default defineWebExtension({
  tools: { note: NoteCall, notify: NotifyCall, memory: MemoryCall, remember: RememberCall },
  entries: {
    'lineage.branched': Branched,
    'lineage.note': Note,
    'lineage.finished': Finished,
    'lineage.woken': Woken,
    'lineage.abstract': Abstract,
    'lineage.rewound': Rewound,
    'lineage.rewound-dependent': RewoundDependent,
    'pi.reset': Reset,
  },
  messageActions: [GoBackAction],
  composer: RootComposer,
  // After Review, so the switcher's existing mod+1…9 keys stay put.
  surfaces: [
    {
      id: MEMORY_SURFACE,
      title: 'Memory',
      icon: BrainIcon,
      description: 'What every new branch starts from: decisions, facts and lessons',
      order: 70,
      component: MemorySurface,
    },
  ],
  slots: { overlay: [Roots] },
  // A root runs no turns and gets no summaries: its tally speaks for it.
  provides: [provide(Unsummarized, (id) => useRoots()?.includes(id) ?? false)],
})
