import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  InboxIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import {
  cn,
  defineWebExtension,
  events,
  formatAgo,
  formatTime,
  Header,
  provide,
  Sidebar,
  useDocOf,
  useEvent,
  useNow,
  useUltimate,
  useViewport,
} from '@/sdk'
import { FeatureTag, useOverview, useStandingName } from '../conversations/ui.tsx'
import { Body, emptyMessages, MessageImages, MessagesDoc, stateTone } from '../messages/ui.tsx'
import type { Message } from '../messages/refs.ts'
import { MessageQuestions } from '../questions/ui.tsx'
import { UnderUltimate } from '../sidebar/ui.tsx'
import { talkToUltimate } from '../subagents/ui.tsx'
import { answeredToday, inboxItems, lead, previewUrl, selection } from './items.tsx'

const SURFACE = 'inbox'
const HOUR = 60 * 60_000
const amber = stateTone.waits

/** The messages that wait on the user, oldest first, read live from the Messages log. */
function useItems() {
  const log = useDocOf(1, MessagesDoc) ?? emptyMessages
  return { items: inboxItems(log.messages), messages: log.messages }
}

/** Who asks, as the sidebar draws a branch: its feature chip (or a standing agent's `@name`) and `#id`. */
function Asker({ id }: { id: Message['from'] }) {
  const overview = useOverview()
  const agent = useStandingName(typeof id === 'number' ? id : 0)
  if (typeof id !== 'number') return <span className="font-mono text-[10.5px]">{id}</span>
  const feature = agent ? undefined : overview[id]?.feature
  return (
    <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground/70">
      {feature && <FeatureTag className="max-w-40 shrink" feature={feature} />}
      {agent && <span className="shrink-0 text-foreground/80">{agent}</span>}
      <span className="shrink-0">#{id}</span>
    </span>
  )
}

/** How long it has waited; amber once it is over an hour. */
function Waited({ at, now }: { at: number; now: number }) {
  return (
    <time
      className={cn(
        'shrink-0 font-mono text-[11px] tabular-nums',
        now - at > HOUR ? amber : 'text-muted-foreground',
      )}
      dateTime={new Date(at).toISOString()}
      title={`Asked ${new Date(at).toLocaleString()}`}
    >
      {formatAgo(at, now)}
    </time>
  )
}

const KindTag = ({ text }: { text: string }) => (
  <span className="shrink-0 rounded border border-border/70 px-1 font-mono text-[10px] leading-4 text-muted-foreground">
    {previewUrl(text) ? 'preview' : 'question'}
  </span>
)

function Row({
  item,
  now,
  selected,
  onSelect,
}: {
  item: Message
  now: number
  selected: boolean
  onSelect: () => void
}) {
  const gist = item.questions?.[0]?.text
  const more = (item.questions?.length ?? 0) > 1 ? ` +${item.questions!.length - 1}` : ''
  return (
    <button
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full cursor-pointer flex-col gap-1 rounded-md px-3 py-2.5 text-left outline-none hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-ring',
        selected && 'bg-accent/60 hover:bg-accent/60',
      )}
      data-inbox-row={item.id}
      onClick={(event) => {
        // A focused row would keep the answer card's keys for itself (the card leaves other buttons theirs).
        event.currentTarget.blur()
        onSelect()
      }}
      type="button"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Asker id={item.from} />
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <KindTag text={item.text} />
          <Waited at={item.at} now={now} />
        </span>
      </span>
      <span className="truncate text-[13px] font-medium text-foreground">
        {lead(item.text).title}
      </span>
      {gist && (
        <span className="truncate text-[12px] text-muted-foreground">
          {gist}
          {more && <span className="font-mono text-[11px]">{more}</span>}
        </span>
      )}
    </button>
  )
}

const Key = ({ children }: { children: string }) => (
  <Kbd className="h-4 min-w-4 rounded-[3px] px-1 font-mono text-[10px]">{children}</Kbd>
)

function List({
  items,
  now,
  selected,
  onSelect,
  phone,
}: {
  items: Message[]
  now: number
  selected: number | undefined
  onSelect: (id: number) => void
  phone: boolean
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-5 pt-4 pb-2">
        <span className="section-label">
          Waiting on you · <span className={amber}>{items.length}</span>
        </span>
        <span className="section-label">oldest first</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4" data-inbox-list>
        {items.map((item) => (
          <Row
            item={item}
            key={item.id}
            now={now}
            onSelect={() => onSelect(item.id)}
            selected={item.id === selected}
          />
        ))}
      </div>
      {!phone && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/70 px-5 py-2 font-mono text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Key>j</Key>
            <Key>k</Key> next
          </span>
          <span className="flex items-center gap-1">
            <Key>⇧↵</Key> accept picks
          </span>
          <span className="flex items-center gap-1">
            <Key>⇧O</Key> open branch
          </span>
        </div>
      )}
    </div>
  )
}

/** Opens the asking conversation at the message, as the To-dos rows did: messages scrolls to its card. */
function useOpenBranch() {
  const { showSurface, switchConversation } = useUltimate()
  return (item: Message) => {
    if (typeof item.from !== 'number') return
    events.emit('messages:open', { conversation: item.from, message: item.id })
    showSurface('agent')
    switchConversation(item.from)
  }
}

/** The reading pane's scroller: positioned, as the transcript's is, so an absolutely positioned descendant of what it
 * reads stays inside it. A question's `sr-only` legend otherwise takes the page as its containing block and lays itself
 * out at its static position below the window, letting the whole page scroll one screen into empty background (#19598).
 */
const pane = 'relative min-h-0 flex-1 overflow-y-auto'

function Reading({
  item,
  now,
  phone,
  onBack,
}: {
  item: Message
  now: number
  phone: boolean
  onBack: () => void
}) {
  const openBranch = useOpenBranch()
  const { title, body } = lead(item.text)
  const preview = previewUrl(item.text)
  const top = (
    <>
      <header className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
        <Asker id={item.from} />
        <span>·</span>
        <KindTag text={item.text} />
        <span className="ml-auto flex items-center gap-1">
          waited <Waited at={item.at} now={now} />
        </span>
      </header>
      <h2 className="mt-3 text-[17px] leading-7 font-semibold tracking-[-0.01em]">{title}</h2>
      {body && (
        // Body's own card padding and 13px give way to the reading pane's prose.
        <div className="mt-1 [&>div]:px-0 [&>div]:py-0 [&>div]:text-[15px] [&>div]:leading-6">
          <Body text={body} />
        </div>
      )}
      {item.images && typeof item.from === 'number' && (
        <div className="mt-4 overflow-hidden rounded-lg border border-border/70 bg-card/60 [&>div]:border-t-0">
          <MessageImages conversation={item.from} entry={item.images.entry} />
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {preview && (
          <Button asChild size="sm" variant="outline">
            <a href={preview} rel="noreferrer" target="_blank">
              <ExternalLinkIcon className="size-3.5" />
              Open preview
            </a>
          </Button>
        )}
        {typeof item.from === 'number' && (
          <Button
            className="text-muted-foreground"
            onClick={() => openBranch(item)}
            size="sm"
            variant="ghost"
          >
            <GitBranchIcon className="size-3.5" />
            Open in branch #{item.from}
          </Button>
        )}
      </div>
    </>
  )
  // The card takes the desktop keys here, whatever conversation is shown behind the Inbox; keyed by message so a new
  // item starts with a fresh draft.
  const answer = (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-card/60">
      <MessageQuestions key={item.id} keys={!phone} message={item} />
    </div>
  )
  if (phone)
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-inbox-item={item.id}>
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 px-2">
          <Button aria-label="Back to the Inbox" onClick={onBack} size="icon" variant="ghost">
            <ArrowLeftIcon className="size-4" />
          </Button>
          <span className="section-label">Inbox</span>
        </div>
        <div className={cn(pane, 'px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]')}>
          {top}
          <div className="mt-5">{answer}</div>
        </div>
      </div>
    )
  return (
    <div className={pane} data-inbox-item={item.id}>
      <div className="mx-auto w-full max-w-[44rem] px-8 pt-8 pb-12">
        {top}
        <div className="mt-6">{answer}</div>
      </div>
    </div>
  )
}

function Zero({ messages, now }: { messages: readonly Message[]; now: number }) {
  const actions = useUltimate()
  const today = answeredToday(messages, now)
  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto" data-inbox-zero>
      <div className="m-auto flex w-full max-w-md flex-col items-center px-6 py-12 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-muted/60">
          <CheckIcon className="size-5 text-muted-foreground" />
        </span>
        <h2 className="mt-4 text-[17px] font-semibold tracking-[-0.01em]">Nothing waits on you</h2>
        <p className="mt-1 text-[14px] text-muted-foreground">Every branch has what it needs.</p>
        <Button
          className="mt-6"
          // oxlint-disable-next-line typescript/no-floating-promises -- an uncaught action failure becomes a notice.
          onClick={() => void talkToUltimate(actions)}
        >
          Back to @ultimate
        </Button>
        {today.length > 0 && (
          <div className="mt-10 w-full text-left">
            <div className="section-label px-1 pb-2">Answered today · {today.length}</div>
            {today.map(({ message, at }) => (
              <div className="flex min-w-0 items-center gap-2 px-1 py-1.5" key={message.id}>
                <CheckIcon className="size-3 shrink-0 text-muted-foreground/70" />
                <span className="max-w-44 shrink-0">
                  <Asker id={message.from} />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                  {lead(message.text).title}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">
                  {formatTime(at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** A link's or a push's wish to show one item, held until the surface mounts and reads it. */
let wanted: number | undefined

function Inbox() {
  const phone = useViewport() === 'phone'
  const now = useNow(60_000)
  const { items, messages } = useItems()
  const openBranch = useOpenBranch()
  // What the user picked, and where it stood: when it leaves (answered), the one now at that place is shown.
  const [picked, setPicked] = useState<number | null>(() => wanted ?? null)
  const [index, setIndex] = useState(0)
  // On a phone the list comes first; an item opens full screen only once tapped or linked.
  const [open, setOpen] = useState(() => wanted !== undefined)
  useEffect(() => {
    wanted = undefined
  }, [])
  const selected = selection(items, picked, index)
  const at = items.findIndex((candidate) => candidate.id === selected)
  const item = items[at]
  // Hold on to the item shown, also one that took an answered item's place, so a later change elsewhere in the list
  // does not move the selection (and drop a half-answered card).
  useEffect(() => {
    if (at >= 0) setIndex(at)
    if (selected !== undefined && selected !== picked) setPicked(selected)
  }, [at, selected, picked])
  const select = (id: number) => {
    setPicked(id)
    setOpen(true)
  }
  useEvent('inbox:show', (id) => {
    wanted = undefined
    select(id as number)
  })

  // j/k move the selection, ⇧O opens the branch; the answer card keeps 1–9, letters and Enter.
  const keys = useRef({ items, at, item, openBranch })
  keys.current = { items, at, item, openBranch }
  useEffect(() => {
    if (phone) return undefined
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest('input, textarea, select, [contenteditable="true"]') ||
        // A dialog, menu or popover (the palette, a picker) owns the keys while it is open.
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
        )
      )
        return
      const current = keys.current
      if (event.key === 'O' && current.item) {
        event.preventDefault()
        current.openBranch(current.item)
      } else if ((event.key === 'j' || event.key === 'k') && current.items.length) {
        event.preventDefault()
        const step = event.key === 'j' ? 1 : -1
        const next = Math.max(0, Math.min(current.items.length - 1, current.at + step))
        setPicked(current.items[next].id)
      }
    }
    // Capture: a choice letter j or k on the card stays j/k here, the Inbox's own navigation.
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [phone])

  const title = (
    <span className="flex shrink-0 items-center gap-2 text-[13px] font-medium">
      <InboxIcon className="size-4 text-muted-foreground" />
      Inbox
      {items.length > 0 && (
        <span className={cn('font-mono text-[11px]', amber)}>{items.length}</span>
      )}
    </span>
  )
  // Keyed by message: each item starts fresh, its images included.
  const reading = item && (
    <Reading item={item} key={item.id} now={now} onBack={() => setOpen(false)} phone={phone} />
  )
  return (
    <div className="flex min-h-0 flex-1">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        {!(phone && open && item) && <Header>{title}</Header>}
        {!items.length ? (
          <Zero messages={messages} now={now} />
        ) : phone ? (
          open && item ? (
            reading
          ) : (
            <List items={items} now={now} onSelect={select} phone selected={undefined} />
          )
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="flex w-[24rem] shrink-0 flex-col border-r border-border/70">
              <List items={items} now={now} onSelect={select} phone={false} selected={selected} />
            </div>
            {reading}
          </div>
        )}
      </main>
    </div>
  )
}

/** Shows the Inbox at `message`: a mounted Inbox selects it, else the one about to mount starts there. */
function show(message: number | undefined, showSurface: (id: string) => void) {
  if (message !== undefined) {
    wanted = message
    events.emit('inbox:show', message)
  }
  showSurface(SURFACE)
}

/**
 * `?inbox=<message>` on load, and the `inbox:open {message}` event at runtime (a push's tap), open the Inbox at that
 * item; the parameter then leaves the address, so a reload does not jump again.
 */
function InboxLink() {
  const { showSurface } = useUltimate()
  useEvent('inbox:open', (value) => show((value as { message?: number }).message, showSurface))
  useEffect(() => {
    const url = new URL(location.href)
    if (!url.searchParams.has('inbox')) return
    const message = Number(url.searchParams.get('inbox'))
    url.searchParams.delete('inbox')
    history.replaceState(history.state, '', url)
    show(Number.isSafeInteger(message) && message > 0 ? message : undefined, showSurface)
  }, [showSurface])
  return null
}

/** The sidebar row under @ultimate's: amber with the count and the oldest wait while anything waits on the user. */
function useInboxRow(): ReactNode {
  const actions = useUltimate()
  const now = useNow(60_000)
  const { items } = useItems()
  const active = actions.surface === SURFACE
  const oldest = items[0]
  return (
    <button
      aria-current={active ? 'true' : undefined}
      className={cn(
        'mx-2 flex w-[calc(100%-1rem)] cursor-pointer items-center gap-1.5 rounded-md py-1.5 pr-2 pl-9 text-left outline-none hover:bg-sidebar-accent/50 focus-visible:ring-1 focus-visible:ring-ring',
        active && 'bg-sidebar-accent',
      )}
      data-inbox-sidebar
      onClick={() => actions.showSurface(SURFACE)}
      type="button"
    >
      <InboxIcon className={cn('size-3 shrink-0', oldest ? amber : 'text-muted-foreground')} />
      <span
        className={cn(
          'min-w-0 flex-1 truncate font-mono text-[10.5px]',
          oldest ? amber : 'text-foreground/70',
        )}
      >
        Inbox{oldest && ` · ${items.length}`}
      </span>
      {oldest && (
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          oldest {formatAgo(oldest.at, now)}
        </span>
      )}
      <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/60" />
    </button>
  )
}

export default defineWebExtension({
  slots: { overlay: [InboxLink] },
  surfaces: [
    {
      id: SURFACE,
      title: 'Inbox',
      icon: InboxIcon,
      description: 'Everything that waits on you, oldest first, answered in place',
      order: 10,
      component: Inbox,
    },
  ],
  commands: [
    { id: 'inbox.open', title: 'Open Inbox', run: (context) => context.showSurface(SURFACE) },
  ],
  provides: [provide(UnderUltimate, useInboxRow)],
})
