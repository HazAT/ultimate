import { parseConversationId, parseEntryId } from '../../lib/ids.ts'
import type { ConversationId } from '@earendil-works/pi-durable'
import { BrainIcon, SearchIcon, Trash2Icon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  api,
  cn,
  column,
  defineWebExtension,
  events,
  errorMessage,
  provide,
  Provided,
  formatAgo,
  formatTokens,
  Header,
  island,
  Sidebar,
  StatusLine,
  useDocOf,
  useNow,
  useUiState,
  useUltimate,
  writingAs,
} from '@/sdk'
import { store } from '@/sdk/client'
import { RootComposer } from './banner.solid.tsx'
import { ConversationRef, Unsummarized } from '../conversations/ui.tsx'
import { ForgetAction, MemoryDoc, TallyDoc } from './refs.ts'
import type { MemoryItem } from './refs.ts'
import { MEMORY_FOCUS, MEMORY_SURFACE, MemoryHeader, useRoots } from './ui.tsx'
import { MemoryCall, NotifyCall, RememberCall } from './calls.solid.tsx'
import { Abstract, Branched, Finished, Note, NoteCall, Reset, Woken } from './rows.solid.tsx'
import { GoBackAction, Rewound, RewoundDependent } from './rewind.solid.tsx'

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
  tools: {
    note: island(NoteCall),
    notify: island(NotifyCall),
    memory: island(MemoryCall),
    remember: island(RememberCall),
  },
  entries: {
    'lineage.branched': island(Branched),
    'lineage.note': island(Note),
    'lineage.finished': island(Finished),
    'lineage.woken': island(Woken),
    'lineage.abstract': island(Abstract),
    'lineage.rewound': island(Rewound),
    'lineage.rewound-dependent': island(RewoundDependent),
    'pi.reset': island(Reset),
  },
  messageActions: [island(GoBackAction)],
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
