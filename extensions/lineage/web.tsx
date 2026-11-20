import { parseConversationId, parseEntryId } from '../../lib/ids.ts'
import type { ConversationId } from '@earendil-works/pi-durable'
import {
  BrainIcon,
  ChevronRightIcon,
  CircleCheckIcon,
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  api,
  Card,
  cn,
  column,
  defineWebExtension,
  events,
  errorMessage,
  Fold,
  provide,
  Provided,
  formatAgo,
  formatTime,
  formatTokens,
  Header,
  island,
  Sidebar,
  StatusLine,
  useDocOf,
  useNow,
  useTranscript,
  useUiState,
  useUltimate,
  writingAs,
} from '@/sdk'
import type { EntryRecord, ToolCallView } from '@/sdk'
import { store } from '@/sdk/client'
import { RootComposer } from './banner.solid.tsx'
import { ConversationRef, Unsummarized } from '../conversations/ui.tsx'
import { Open } from '../workspaces/ui.tsx'
import {
  ForgetAction,
  MemoryDoc,
  TallyDoc,
  AbstractEntry,
  FinishedEntry,
  LineageResetEntry,
} from './refs.ts'
import { NoteEntry } from '../entries/ui.tsx'
import { BranchedEntry } from './entries.ts'
import type { MemoryItem } from './refs.ts'
import { MEMORY_FOCUS, MEMORY_SURFACE, MemoryHeader, useRoots } from './ui.tsx'
import { MemoryCall, NotifyCall, RememberCall } from './calls.tsx'
import { GoBackAction, Rewound, RewoundDependent } from './rewind.tsx'

function userText(entry: EntryRecord) {
  const message = entry.model?.[0]
  if (message?.role !== 'user') return ''
  return typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}

function Branched({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  if (!BranchedEntry.is(entry)) return null
  const { branch, intent } = entry.data
  if (entry.model) return <Started entry={entry} />
  return (
    <button
      className="flex w-full min-w-0 cursor-pointer items-center gap-3 font-mono text-[11px] text-muted-foreground/70 before:h-px before:flex-1 before:bg-border/70 after:h-px after:flex-1 after:bg-border/70 hover:text-foreground"
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

function Woken() {
  return (
    <div
      className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/70 before:h-px before:flex-1 before:bg-border/70 after:h-px after:flex-1 after:bg-border/70"
      data-lineage-woken
    >
      <span className="flex items-center gap-1.5">
        <SunriseIcon className="size-3 shrink-0" />
        woke after compaction
      </span>
    </div>
  )
}

function Started({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  const [open, setOpen] = useState(false)
  if (!BranchedEntry.is(entry)) return null
  const { branch, at, intent, images, from } = entry.data
  const timestamp = entry.model?.[0]?.timestamp
  return (
    <Card data-lineage-started={branch}>
      <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
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
        className="block w-full min-w-0 cursor-pointer px-3 py-2.5 text-left text-[13px] leading-relaxed"
        onClick={() => setOpen((current) => !current)}
        title={open ? 'Show less' : 'Show more'}
        type="button"
      >
        <span className={cn('block break-words whitespace-pre-wrap', !open && 'line-clamp-3')}>
          <MentionText text={intent} />
        </span>
        {!!images && (
          <span className="mt-1.5 block font-mono text-[11px] text-muted-foreground">
            {images} image{images === 1 ? '' : 's'}
          </span>
        )}
      </button>
    </Card>
  )
}

function Abstract({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  const transcript = useTranscript()
  if (!AbstractEntry.is(entry) || entry.data.anchor !== undefined) return null
  let latestAnchorEdit: EntryRecord = entry
  for (const other of transcript)
    if (other.id > latestAnchorEdit.id && other.edits?.some((edit) => edit.target === entry.id))
      latestAnchorEdit = other
  const anchorOmitted = latestAnchorEdit.edits?.some(
    (edit) => edit.target === entry.id && edit.action === 'omit',
  )
  if (anchorOmitted || !AbstractEntry.is(latestAnchorEdit)) return null
  const { conversation, at, text, title } = latestAnchorEdit.data
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
        <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
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
        <p className="min-w-0 px-3 py-2.5 text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
          <MentionText text={text} />
        </p>
      </section>
    </Fold>
  )
}

function Finished({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  if ((!FinishedEntry.is(entry) && !NoteEntry.is(entry)) || entry.data.from === undefined)
    return null
  const { from, title, text } = entry.data
  return (
    <section
      className="min-w-0 rounded-md border border-l-2 border-border border-l-success/70 bg-muted/20"
      data-lineage-finished={from}
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
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
      <div className="min-w-0 px-3 py-2.5 text-[13px] leading-relaxed">
        <MessageResponse>{text}</MessageResponse>
      </div>
    </section>
  )
}

function NoteCard({
  label,
  id,
  text,
  note,
}: {
  label: string
  id?: ConversationId | string
  text: string
  note: 'received' | 'left'
}) {
  const { switchConversation } = useUltimate()
  return (
    <section
      className="min-w-0 rounded-md border border-l-2 border-note/25 border-l-note/60 bg-note/6"
      data-lineage-note={note}
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-note/15 px-3 py-2 font-mono text-[11px] text-foreground">
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
      <div className="min-w-0 px-3 py-2.5 text-[13px] leading-relaxed">
        <MessageResponse>{text}</MessageResponse>
      </div>
    </section>
  )
}

function Note({ entry, core }: { entry: EntryRecord; core: React.ReactNode }) {
  if (!NoteEntry.is(entry)) return core
  const { from, text, source } = entry.data
  if (source === 'lander') return core
  if (source === 'finished') return <Finished entry={entry} />
  if (source === 'main') return <Catchup text={text} />
  return <NoteCard id={from} label="Note from" note="received" text={text} />
}

function Catchup({ text }: { text: string }) {
  return (
    <Card data-lineage-note="main">
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-foreground">
        <GitBranchIcon className="size-3.5 text-brand" />
        Catch-up
      </header>
      <div className="min-w-0 px-3 py-2.5 text-[13px] leading-relaxed">
        <MessageResponse>{text}</MessageResponse>
      </div>
    </Card>
  )
}

function NoteCall({ call, core }: { call: ToolCallView; core: ReactNode }) {
  if (call.status === 'error' || call.status === 'interrupted') return core
  const left = /^Left a note in #(\d+)\.$/.exec(call.output)
  const to = left ? Number(left[1]) : call.args.to
  return (
    <NoteCard
      id={
        typeof to === 'number' ? parseConversationId(to) : typeof to === 'string' ? to : undefined
      }
      label="Note →"
      note="left"
      text={typeof call.args.text === 'string' ? call.args.text : ''}
    />
  )
}

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
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-brand">
          <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]/genesis:rotate-90" />
          Context starts here{from ? ` · distilled from #${from[1]}/${from[2]}` : ''}
        </span>
        <span className="text-xs text-muted-foreground">
          {source !== undefined && source !== entry.conversationId
            ? 'The project reading is distilled into the start of this context.'
            : 'The conversation before this point is distilled into the start of the context. Earlier messages remain available above.'}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-brand/20 px-3.5 py-2.5 text-[13px]">
        {from && <Open id={parseConversationId(Number(from[1]))} entry={Number(from[2])} />}
        <MessageResponse>{genesis}</MessageResponse>
      </CollapsibleContent>
    </Collapsible>
  )
}

function Reset({ entry, core }: { entry: EntryRecord; core: ReactNode }) {
  const roots = useRoots()
  const lineage = LineageResetEntry.is(entry) ? entry.data?.lineage : undefined
  if (lineage?.tally) return <Genesis entry={entry} />
  if (!entry.model && entry.data === undefined && roots?.includes(entry.conversationId)) return null
  return core
}

function MemorySource({ source }: { source: string }) {
  const { switchConversation, showSurface } = useUltimate()
  const [conversationSource, entrySource] = source.slice(1).split('/')
  const conversation = parseConversationId(Number(conversationSource))
  const entry = parseEntryId(Number(entrySource))
  return (
    <p className="mt-1 flex min-w-0 items-center gap-1 font-mono text-[10.5px] text-muted-foreground/70">
      <span className="shrink-0">learned in</span>
      <button
        className="flex min-w-0 cursor-pointer items-center rounded-sm px-0.5 text-[11px] text-foreground hover:bg-accent"
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
        {entry !== undefined && <span className="shrink-0 text-muted-foreground/70">/{entry}</span>}
      </button>
    </p>
  )
}

function MemoryRow({
  root,
  slug,
  item,
  now,
}: {
  root: ConversationId
  slug: string
  item: MemoryItem
  now: number
}) {
  const [open, setOpen] = useState(false)
  const [forgetting, setForgetting] = useState(false)
  const [requestedMemorySlug, consumeMemoryFocusRequest] = useUiState<string | null>(
    MEMORY_FOCUS,
    null,
  )
  const row = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (requestedMemorySlug !== slug) return
    setOpen(true)
    row.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    writingAs('app', () => consumeMemoryFocusRequest(null))
  }, [requestedMemorySlug, slug, consumeMemoryFocusRequest])
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
          <span className="flex w-full min-w-0 items-center gap-1.5 font-mono text-[10.5px] leading-4 text-muted-foreground">
            <span className="min-w-0 truncate">{slug}</span>
            <span
              className="ml-auto shrink-0 pl-1 text-muted-foreground/60"
              title={new Date(item.updated).toLocaleString()}
            >
              {formatAgo(item.updated, now)}
            </span>
          </span>
          <span
            className={cn(
              'block text-[13px] leading-snug break-words text-foreground/90',
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
              className="invisible mt-1.5 mr-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/70 outline-none group-focus-within/memory:visible group-hover/memory:visible pointer-coarse:visible hover:bg-muted hover:text-error focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
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
          <TooltipContent className="font-mono text-[11px]" side="left">
            Forget this memory
          </TooltipContent>
        </Tooltip>
      </div>
      {open && (
        <div className="min-w-0 px-2 pb-3">
          <div className="min-w-0 text-[13px] leading-relaxed text-muted-foreground">
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

function MemorySurface() {
  const roots = useRoots() ?? []
  const [filter, setFilter] = useState('')
  return (
    <>
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <Header>
            <span className="flex shrink-0 items-center gap-2 text-[13px] font-medium">
              <BrainIcon className="size-4 text-muted-foreground" />
              Memory
            </span>
          </Header>
          <div className="min-h-0 flex-1 overflow-y-auto" data-lineage-memory-surface>
            <div className={cn(column(), 'pt-4 pb-10')}>
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
  root: ConversationId
  label: boolean
  filter: string
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
      {label && <p className="pt-4 font-mono text-[11px] text-foreground">#{root}</p>}
      {slugs.length === 0 ? (
        <p className="py-8 text-[12.5px] text-muted-foreground">
          No memories yet. @ultimate keeps decisions, facts and lessons here as branches land.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-3">
            <p className="min-w-0 font-mono text-[10.5px] text-muted-foreground">
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
                  className="min-w-0 flex-1 bg-transparent font-mono text-[11px] outline-none placeholder:text-muted-foreground/60"
                  onChange={(event) => setFilter(event.target.value)}
                  onKeyDown={(event) => event.key === 'Escape' && setFilter('')}
                  placeholder="filter"
                  value={filter}
                />
              </label>
            )}
          </div>
          {matches.length === 0 && (
            <p className="py-8 font-mono text-[11.5px] text-muted-foreground/70">
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
                  <span className="text-muted-foreground/60">{shown.length}</span>
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

const MEMORY_AFTER_REVIEW_ORDER = 70
function StreamRootsForCommands() {
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
  composer: island(RootComposer),
  surfaces: [
    {
      id: MEMORY_SURFACE,
      title: 'Memory',
      icon: BrainIcon,
      description: 'What every new branch starts from: decisions, facts and lessons',
      order: MEMORY_AFTER_REVIEW_ORDER,
      component: MemorySurface,
    },
  ],
  slots: { overlay: [StreamRootsForCommands] },
  provides: [provide(Unsummarized, (id) => useRoots()?.includes(id) ?? false)],
})
