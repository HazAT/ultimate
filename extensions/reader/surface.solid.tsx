import type { ConversationId } from '@earendil-works/pi-durable'
import {
  ArrowRightIcon,
  CheckIcon,
  CircleAlertIcon,
  FileTextIcon,
  FolderOpenIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  XIcon,
} from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { createEffect, createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import { blockSplitterKeepingFinishedBlocks } from '@/components/markdown/parse.ts'
import { Button } from '@/components/ui/button.solid.tsx'
import { Textarea } from '@/components/ui/input.solid.tsx'
import { Skeleton } from '@/components/ui/skeleton.solid.tsx'
import {
  api,
  cn,
  Conversation,
  Dock,
  errorMessage,
  formatAgo,
  Header,
  keepLast,
  ROOT,
  ScopedConversation,
  showSurface,
  StatusLine,
  switchConversation,
  useAction,
  useConversation,
  useConversationId,
  useDialog,
  useDocOf,
  useNow,
  useViewport,
  writingAs,
} from '@/sdk/solid'
import { SendAction } from '../review/refs.ts'
import {
  anchorOf,
  blockAt,
  blocksOf,
  folderOf,
  localLinks,
  place,
  readSpec,
  selectedLines,
} from './blocks.ts'
import type { Block, Placed } from './blocks.ts'
import { Composer, DraftCard } from './comment.solid.tsx'
import {
  added,
  busyReason,
  draftsKey,
  dropComment,
  excerptOf,
  isUnsaved,
  limits,
  loadWriting,
  putComment,
  putNote,
  saveWriting,
  sendDrafts,
  sendProblem,
  typed,
  withoutSent,
  writingSlot,
} from './comments.ts'
import type { Change, Draft, Drafts, Writing } from './comments.ts'
import { notifyDrafts, tabId, useDrafts } from './drafts.solid.tsx'
import { InReadFile, reachedLine, useLineTarget, usePath } from './link.solid.tsx'
import { pickerDialog } from './picker.solid.tsx'
import { ReadAction, ThreadAction, ThreadsDoc } from './refs.ts'
import type { ReadFile, Thread } from './refs.ts'

type SendOutcome = { conversation: ConversationId; cleared: boolean } | { error: string }
type Sent = { file: string; outcome: SendOutcome }

const splitBlocks = (markdown: string) => blockSplitterKeepingFinishedBlocks()(markdown)

export default function ReaderSurface() {
  const [path, setPath] = usePath()
  const shown = useConversationId()
  const threads = useDocOf(() => ROOT, ThreadsDoc)
  const thread = createMemo(() => {
    const all = threads()?.threads
    const current = path()
    return all && Object.hasOwn(all, current) ? all[current] : undefined
  })
  const [sent, setSent] = createSignal<Sent>()
  const [sending, setSending] = createSignal(false)
  const reader = () => (
    <Reader
      origin={thread()?.from ?? shown()}
      path={path()}
      sending={sending()}
      sent={sent()}
      setPath={setPath}
      setSending={setSending}
      setSent={setSent}
      shown={shown()}
      thread={thread()}
    />
  )
  return (
    <Show when={thread()?.id ?? shown()} fallback={reader()}>
      {(docked) => <ScopedConversation id={docked()}>{reader()}</ScopedConversation>}
    </Show>
  )
}

type ReaderProps = {
  path: string
  setPath: (path: string) => void
  thread?: Thread
  origin?: ConversationId
  shown?: ConversationId
  sent?: Sent
  setSent: (sent: Sent | undefined) => void
  sending: boolean
  setSending: (sending: boolean) => void
}

function Reader(props: ReaderProps) {
  const viewport = useViewport()
  const phone = () => viewport() === 'phone'
  return (
    <Show when={props.path} fallback={<Frame phone={phone()} body={<NoFile />} />}>
      <Opened {...props} phone={phone()} />
    </Show>
  )
}

function Frame(props: {
  phone: boolean
  header?: JSX.Element
  body: JSX.Element
  footer?: JSX.Element
}) {
  return (
    <>
      <Header>
        <span class="flex shrink-0 items-center gap-2 text-[13px] font-medium">
          <FileTextIcon class="size-4 text-muted-foreground" />
          <span class="max-md:hidden">Read</span>
        </span>
        {props.header}
      </Header>
      <div class="flex min-h-0 flex-1">
        <div class="flex min-w-0 flex-1 flex-col">
          <div class="min-h-0 flex-1 overflow-y-auto" data-reader-scroll="">
            <div class="mx-auto w-full max-w-[46rem] px-5 pt-8 pb-24 sm:px-10">{props.body}</div>
          </div>
          {props.footer}
        </div>
        <Show when={!props.phone}>
          <Dock>
            <Conversation variant="dock" />
          </Dock>
        </Show>
      </div>
      <StatusLine />
    </>
  )
}

function PickButton(props: { label: string; variant?: 'ghost' | 'outline' }) {
  const [, setPicker] = useDialog(pickerDialog)
  return (
    <Button
      aria-label={props.label}
      onClick={() => setPicker(true)}
      size="xs"
      title={props.label}
      variant={props.variant ?? 'outline'}
    >
      <FolderOpenIcon />
      {props.label}
    </Button>
  )
}

function Notice(props: { children: JSX.Element }) {
  return (
    <div class="flex flex-1 flex-col items-center gap-3 px-6 py-16 text-center font-mono text-[11.5px] text-muted-foreground/80">
      {props.children}
    </div>
  )
}

function NoFile() {
  return (
    <Notice>
      <FileTextIcon class="size-5 text-muted-foreground/60" />
      <span>Open a markdown file to read it here and comment on it.</span>
      <PickButton label="Pick a file…" />
      <span class="text-muted-foreground/60">or click a .md path in the conversation</span>
    </Notice>
  )
}

function Loading() {
  return (
    <div class="space-y-3 py-2">
      <Skeleton class="h-6 w-1/2" />
      <Skeleton class="h-4" />
      <Skeleton class="h-4 w-5/6" />
      <Skeleton class="h-4 w-2/3" />
    </div>
  )
}

function Opened(props: ReaderProps & { phone: boolean }) {
  const conversation = useConversation()
  const now = useNow(60_000)
  const file = useAction(
    ReadAction,
    {
      get path() {
        return props.path
      },
      get conversation() {
        return props.origin
      },
    },
    {
      conversation: ROOT,
      on: () => [conversation().entries.length, conversation().busy],
      focus: true,
      onError: keepLast,
    },
  )
  const data = createMemo<ReadFile | undefined>(
    (previous) => file.data() ?? (previous?.absolute === props.path ? previous : undefined),
  )
  createEffect(
    () => ({ absolute: data()?.absolute, path: props.path }),
    (next) => {
      if (next.absolute && next.absolute !== next.path)
        writingAs('app', () => props.setPath(next.absolute!))
    },
  )
  const storeKey = () => draftsKey(data()?.absolute ?? props.path)
  const [drafts, update] = useDrafts(storeKey)
  const noteUnsaved = () => {
    drafts()
    return isUnsaved(localStorage, storeKey(), 'note')
  }
  const outcome = () => {
    const sent = props.sent
    return sent && sent.file === (data()?.absolute ?? props.path) ? sent.outcome : undefined
  }
  const sentTo = () => {
    const result = outcome()
    return result && 'conversation' in result ? result : undefined
  }
  const sendError = () => {
    const result = outcome()
    return result && 'error' in result ? result.error : undefined
  }

  const [discardRefused, setDiscardRefused] = createSignal(false)

  const deliver = async (sent: ReadFile, from: ConversationId, snapshot: Drafts) => {
    const lines = sent.text.replace(/\r\n?/g, '\n').split('\n')
    const thread = await api.action(ThreadAction, { path: sent.absolute, conversation: from })
    const result = await api.action(SendAction, {
      conversation: thread.id,
      spec: readSpec(sent.absolute),
      comments: snapshot.comments
        .map((draft) => {
          const at = place(draft, lines)
          return {
            file: sent.path,
            side: 'new' as const,
            start: at.start,
            end: at.end,
            excerpt: draft.excerpt,
            text: draft.text,
          }
        })
        .toSorted((a, b) => a.start - b.start || a.end - b.end),
      ...(snapshot.note.trim() && { note: snapshot.note }),
    })
    return result.conversation
  }

  const send = async () => {
    const shownFile = data()
    const from = props.origin
    const key = storeKey()
    if (!shownFile || from === undefined) return
    const report = (result: SendOutcome) =>
      props.setSent({ file: shownFile.absolute, outcome: result })
    props.setSending(true)
    props.setSent(undefined)
    try {
      const { to, cleared } = await sendDrafts(localStorage, key, (snapshot) =>
        deliver(shownFile, from, snapshot),
      )
      notifyDrafts()
      report({ conversation: to, cleared })
    } catch (failure) {
      report({ error: errorMessage(failure) })
    } finally {
      props.setSending(false)
    }
  }

  const docked = () => props.thread?.id ?? props.shown
  return (
    <Frame
      body={
        <Show
          when={data()}
          fallback={
            <Show when={!file.loading() && file.error()} fallback={<Loading />}>
              {(error) => (
                <Notice>
                  <span class="text-error">{errorMessage(error())}</span>
                  <PickButton label="Pick another file…" />
                </Notice>
              )}
            </Show>
          }
        >
          {(shownFile) => (
            <Show when={storeKey()} keyed>
              {(key) => (
                <Document drafts={drafts()} file={shownFile()} storeKey={key} update={update} />
              )}
            </Show>
          )}
        </Show>
      }
      footer={
        <>
          <Show when={sentTo()}>
            {(sent) => (
              <SentBar
                cleared={sent().cleared}
                onClose={() => props.setSent(undefined)}
                to={sent().conversation}
              />
            )}
          </Show>
          <Show when={drafts().comments.length > 0 || drafts().note}>
            <Footer
              discardRefused={discardRefused()}
              drafts={drafts()}
              error={sendError()}
              noteUnsaved={noteUnsaved()}
              onDiscard={() => setDiscardRefused(!update(withoutSent(drafts())))}
              onNote={(note) => update(putNote(note))}
              onSend={send}
              origin={props.origin}
              sending={props.sending}
              thread={props.thread?.id}
            />
          </Show>
        </>
      }
      header={
        <>
          <span
            class="min-w-0 truncate font-mono text-[12px] text-foreground/85"
            title={data() ? `${data()!.absolute}\nin ${data()!.root}` : props.path}
          >
            {data()?.path ?? props.path}
          </span>
          <Show when={data()}>
            {(shownFile) => (
              <span class="shrink-0 font-mono text-[11px] text-muted-foreground/70 max-sm:hidden">
                edited {formatAgo(shownFile().mtime, now(), { ago: true })}
              </span>
            )}
          </Show>
          <span class="ml-auto" />
          <PickButton label="Open…" variant="ghost" />
          <Show when={props.phone && docked()}>
            {(id) => (
              <Button
                aria-label={props.thread ? `Show this file's thread #${id()}` : `Show #${id()}`}
                onClick={() => {
                  switchConversation(id())
                  showSurface('agent')
                }}
                size="xs"
                variant="ghost"
              >
                <MessageSquareIcon />#{id()}
              </Button>
            )}
          </Show>
        </>
      }
      phone={props.phone}
    />
  )
}

type Pick = {
  first: number
  last: number
  text: string
  around: { before: string; after: string }
  top?: number
  left?: number
}

function selectionAround(range: Range, first: HTMLElement, last: HTMLElement) {
  const textBeside = (block: HTMLElement, edge: 'before' | 'after') => {
    const content = block.querySelector('[data-reader-content]')
    const boundary = edge === 'before' ? range.startContainer : range.endContainer
    if (!content?.contains(boundary)) return ''
    const part = document.createRange()
    if (edge === 'before') {
      part.setStart(content, 0)
      part.setEnd(range.startContainer, range.startOffset)
    } else {
      part.setStart(range.endContainer, range.endOffset)
      part.setEnd(content, content.childNodes.length)
    }
    return part.toString()
  }
  return { before: textBeside(first, 'before'), after: textBeside(last, 'after') }
}

function pickOf(root: HTMLElement | undefined): Pick | undefined {
  const selection = getSelection()
  if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return undefined
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return undefined
  const start =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement
  if (start?.closest('[data-reader-ui]')) return undefined
  const blocks = [...root.querySelectorAll<HTMLElement>('[data-reader-block]')].filter((block) =>
    range.intersectsNode(block),
  )
  const text = selection.toString()
  const first = blocks[0]
  const last = blocks.at(-1)
  if (!first || !last || !text.trim()) return undefined
  const firstLine =
    [...range.getClientRects()].find((rect) => rect.width > 0) ?? range.getBoundingClientRect()
  const box = root.getBoundingClientRect()
  const scroller = root.closest('[data-reader-scroll]')?.getBoundingClientRect()
  const roomInMargin = scroller !== undefined && scroller.right - box.right >= 120
  return {
    first: Number(first.dataset.readerBlock),
    last: Number(last.dataset.readerBlock),
    text,
    around: selectionAround(range, first, last),
    ...(roomInMargin && { top: firstLine.top - box.top, left: box.width + 16 }),
  }
}

function FrontMatter(props: { source: string }) {
  return (
    <pre class="mb-6 overflow-x-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 font-mono text-[11.5px] leading-[1.6] whitespace-pre-wrap text-muted-foreground">
      {props.source.split('\n').slice(1, -1).join('\n') || ' '}
    </pre>
  )
}

type Shown = { draft: Draft; at: Placed; block: number }

function Document(props: {
  file: ReadFile
  drafts: Drafts
  storeKey: string
  update: (change: Change) => boolean
}) {
  const text = createMemo(() => props.file.text.replace(/\r\n?/g, '\n'))
  const lines = createMemo(() => text().split('\n'))
  const blocks = createMemo(() =>
    blocksOf(localLinks(text(), folderOf(props.file.absolute)), splitBlocks),
  )
  let article: HTMLElement | undefined
  const [pick, setPick] = createSignal<Pick>()
  const stored = createMemo(() => loadWriting(localStorage, props.storeKey, lines(), tabId()))
  const [own, setOwn] = createSignal<{ writing?: Writing }>()
  const writing = createMemo(() => {
    const set = own()
    return set ? set.writing : stored()
  })
  const [deleteRefused, setDeleteRefused] = createSignal<string>()
  const [unsaved, setUnsaved] = createSignal(() =>
    isUnsaved(localStorage, props.storeKey, writingSlot(tabId())),
  )
  const write = (next: Writing | undefined) => {
    setOwn({ writing: next })
    setUnsaved(!props.update(saveWriting(next, tabId())))
  }

  onSettled(() => {
    const read = () => setPick(pickOf(article))
    document.addEventListener('selectionchange', read)
    return () => document.removeEventListener('selectionchange', read)
  })

  const target = useLineTarget()
  createEffect(
    () => ({ at: target(), all: blocks() }),
    ({ at, all }) => {
      if (!at || !all.length) return
      const box = article?.querySelector<HTMLElement>(
        `[data-reader-block="${blockAt(all, at.line)}"] [data-reader-box]`,
      )
      box?.scrollIntoView({ block: 'center' })
      box?.animate?.(
        [
          { backgroundColor: 'color-mix(in oklab, var(--brand) 14%, transparent)' },
          { backgroundColor: 'transparent' },
        ],
        { duration: 1500, easing: 'ease-out' },
      )
      reachedLine()
    },
  )

  const shown = createMemo<Shown[]>(() =>
    props.drafts.comments.map((draft) => {
      const at = place(draft, lines())
      return { draft, at, block: blockAt(blocks(), at.end) }
    }),
  )
  const writingBlock = () => {
    const current = writing()
    return current ? blockAt(blocks(), current.end) : undefined
  }
  const marked = createMemo(() => {
    const all = new Map<number, boolean>()
    for (const item of shown())
      for (let block = blockAt(blocks(), item.at.start); block <= item.block; block++)
        all.set(block, false)
    const current = writing()
    const end = writingBlock()
    if (current && end !== undefined)
      for (let block = blockAt(blocks(), current.start); block <= end; block++) all.set(block, true)
    return all
  })

  const comment = () => {
    const chosen = pick()
    const first = chosen && blocks()[chosen.first]
    const last = chosen && blocks()[chosen.last]
    if (!chosen || !first || !last) return
    const range = selectedLines(lines(), first, last, chosen.text, chosen.around)
    write({
      ...range,
      excerpt: excerptOf(chosen.text),
      anchor: anchorOf(lines(), range.start, range.end),
      text: '',
    })
    getSelection()?.removeAllRanges()
    setPick(undefined)
  }

  const submit = (body: string) => {
    const current = writing()
    if (!current) return
    const editing = current.id
      ? props.drafts.comments.find((draft) => draft.id === current.id)
      : undefined
    const draft: Draft = editing
      ? { ...editing, text: body }
      : {
          id: crypto.randomUUID(),
          start: current.start,
          end: current.end,
          excerpt: current.excerpt,
          anchor: current.anchor,
          text: body,
        }
    write(added(current, props.update(putComment(draft))))
  }

  return (
    <InReadFile value={true}>
      <article aria-live="off" class="relative" ref={article} role="log">
        <For each={blocks()} keyed={false}>
          {(block, index) => (
            <ReaderBlock
              block={block()}
              index={index}
              marked={marked().get(index)}
              after={
                <>
                  <For
                    each={shown().filter(
                      (item) => item.block === index && item.draft.id !== writing()?.id,
                    )}
                    keyed={(item) => item.draft.id}
                  >
                    {(item) => (
                      <DraftCard
                        changed={item().at.changed}
                        editBlocked={busyReason(writing())}
                        excerpt={item().draft.excerpt}
                        id={item().draft.id}
                        lines={item().at}
                        deleteRefused={deleteRefused() === item().draft.id}
                        onDelete={() =>
                          setDeleteRefused(
                            props.update(dropComment(item().draft.id))
                              ? undefined
                              : item().draft.id,
                          )
                        }
                        onEdit={() =>
                          write({
                            start: item().at.start,
                            end: item().at.end,
                            excerpt: item().draft.excerpt,
                            anchor: item().draft.anchor,
                            text: item().draft.text,
                            id: item().draft.id,
                          })
                        }
                        text={item().draft.text}
                      />
                    )}
                  </For>
                  <Show when={writingBlock() === index && writing()}>
                    {(current) => (
                      <Composer
                        excerpt={current().excerpt}
                        lines={current()}
                        onCancel={() => write(undefined)}
                        onSubmit={submit}
                        onText={(next) => write(typed(current(), next))}
                        refused={!!current().refused || unsaved()}
                        submit={current().id ? 'Save' : 'Add comment'}
                        text={current().text}
                      />
                    )}
                  </Show>
                </>
              }
            />
          )}
        </For>
        <Show when={pick()}>
          {(chosen) => (
            <Button
              aria-disabled={writing() ? 'true' : undefined}
              aria-label="Comment on the selection"
              class={cn(
                'z-10 shadow-md',
                chosen().top === undefined
                  ? 'fixed bottom-20 left-1/2 h-8 -translate-x-1/2 rounded-full px-3.5 text-[13px]'
                  : 'absolute',
                writing() && 'cursor-not-allowed opacity-50',
              )}
              data-reader-comment=""
              onClick={() => {
                if (!writing()) comment()
              }}
              onMouseDown={(event: MouseEvent) => event.preventDefault()}
              size="xs"
              style={
                chosen().top === undefined
                  ? undefined
                  : { top: `${chosen().top}px`, left: `${chosen().left}px` }
              }
              title={busyReason(writing()) ?? 'Comment on the selection'}
            >
              <MessageSquarePlusIcon />
              Comment
            </Button>
          )}
        </Show>
      </article>
    </InReadFile>
  )
}

function ReaderBlock(props: { block: Block; index: number; marked?: boolean; after: JSX.Element }) {
  return (
    <div
      class="mt-3 first:mt-0 has-[h1,h2,h3]:mt-6"
      data-end={props.block.end}
      data-reader-block={props.index}
      data-start={props.block.start}
    >
      <div class="group/block relative -mx-3 rounded-md px-3" data-reader-box="">
        <span
          aria-hidden="true"
          class="pointer-events-none absolute top-0 right-full mr-2 font-mono text-[10.5px] leading-[1.6] text-muted-foreground/0 tabular-nums transition-colors select-none group-hover/block:text-muted-foreground/50 max-md:hidden"
        >
          {props.block.start}
        </span>
        <Show when={props.marked !== undefined}>
          <span
            aria-hidden="true"
            class={cn(
              'absolute inset-y-0.5 left-0 w-0.5 rounded-full',
              props.marked ? 'bg-brand' : 'bg-brand/45',
            )}
          />
        </Show>
        <div data-reader-content="">
          <Show when={props.block.frontMatter} fallback={<Markdown text={props.block.source} />}>
            <FrontMatter source={props.block.source} />
          </Show>
        </div>
      </div>
      {props.after}
    </div>
  )
}

function Footer(props: {
  drafts: Drafts
  noteUnsaved: boolean
  discardRefused: boolean
  onNote: (note: string) => void
  onDiscard: () => void
  thread?: ConversationId
  origin?: ConversationId
  sending: boolean
  error?: string
  onSend: () => Promise<void>
}) {
  const [noting, setNoting] = createSignal(false)
  const count = () => props.drafts.comments.length
  const over = () => count() > limits.comments
  const problem = () => sendProblem(props.drafts)
  const sendTitle = () =>
    problem() ??
    (props.thread === undefined && props.origin !== undefined
      ? `Starts a thread for this file, a branch of #${props.origin}; later Sends go to it`
      : undefined)
  return (
    <div
      class="shrink-0 border-t border-border/70 bg-sidebar px-3 py-2 md:px-4"
      data-reader-footer=""
    >
      <Show when={noting() || props.drafts.note}>
        <Textarea
          aria-label="Overall note"
          class="mb-2 block max-h-40 min-h-12 w-full resize-y rounded-md border border-border/70 bg-background px-2.5 py-1.5 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/50 focus:border-brand/50 focus-visible:ring-0"
          onValueChange={(note) => props.onNote(note)}
          placeholder="An overall note (optional)"
          value={props.drafts.note}
        />
      </Show>
      <Show when={props.drafts.note.length > limits.text}>
        <p class="mb-2 font-mono text-[11.5px] text-error" data-reader-note-over="" role="alert">
          {props.drafts.note.length.toLocaleString('en-US')} / {limits.text.toLocaleString('en-US')}{' '}
          · shorten the note to send
        </p>
      </Show>
      <Show when={props.noteUnsaved}>
        <p class="mb-2 font-mono text-[11.5px] text-error" data-reader-unsaved="" role="alert">
          Not saved: this browser's storage is full. The note stays here until you send or shorten
          it
        </p>
      </Show>
      <Show when={props.discardRefused}>
        <p class="mb-2 font-mono text-[11.5px] text-error" data-reader-unsaved="" role="alert">
          Not discarded: this browser's storage refused it. The comments stay until you try again
        </p>
      </Show>
      <Show when={props.error}>
        {(error) => (
          <p class="mb-2 flex items-start gap-1.5 font-mono text-[11.5px] text-error" role="alert">
            <CircleAlertIcon class="mt-px size-3.5 shrink-0" />
            <span class="min-w-0 break-words">Not sent: {error()}</span>
          </p>
        )}
      </Show>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span class="flex items-center gap-1.5 font-mono text-[11.5px] text-muted-foreground">
          <MessageSquareIcon class="size-3.5 text-brand" />
          <span class={cn(over() && 'text-error')} data-reader-count="">
            {count() === 0
              ? 'No comments · add a comment to send'
              : `${count()} comment${count() === 1 ? '' : 's'}`}
            {over() && ` · at most ${limits.comments}`}
          </span>
        </span>
        <Show when={!noting() && !props.drafts.note}>
          <Button
            aria-label="Add an overall note"
            class="font-mono text-[11.5px] font-normal text-muted-foreground hover:text-foreground"
            onClick={() => setNoting(true)}
            size={null}
            variant={null}
          >
            + note
          </Button>
        </Show>
        <div class="ml-auto flex items-center gap-1.5">
          <Button
            aria-label="Discard pending comments"
            data-agent-confirm="Discards every pending comment and the note on this file."
            onClick={() => {
              setNoting(false)
              props.onDiscard()
            }}
            size="xs"
            variant="ghost"
          >
            Discard
          </Button>
          <Button
            data-reader-send=""
            disabled={
              props.sending ||
              problem() !== undefined ||
              (props.thread ?? props.origin) === undefined
            }
            onClick={() => props.onSend()}
            size="xs"
            title={sendTitle()}
          >
            {props.sending
              ? 'Sending…'
              : props.thread === undefined
                ? 'Send to new thread'
                : `Send to #${props.thread}`}
            <ArrowRightIcon />
          </Button>
        </div>
      </div>
    </div>
  )
}

function SentBar(props: { to: ConversationId; cleared: boolean; onClose: () => void }) {
  return (
    <output
      class="flex shrink-0 items-center gap-2 border-t border-border/70 bg-sidebar px-3 py-2 font-mono text-[11.5px] md:px-4"
      data-reader-sent=""
    >
      <Show
        when={props.cleared}
        fallback={<CircleAlertIcon class="size-3.5 shrink-0 text-warning" />}
      >
        <CheckIcon class="size-3.5 shrink-0 text-success" />
      </Show>
      <span class="min-w-0">
        <span class="text-muted-foreground">Sent to </span>
        <Button
          aria-label={`Open thread #${props.to}`}
          class="inline font-normal text-foreground/90 hover:underline"
          onClick={() => {
            switchConversation(props.to)
            showSurface('agent')
          }}
          size={null}
          variant={null}
        >
          #{props.to}
        </Button>
        <Show when={!props.cleared}>
          <span class="text-warning" data-reader-uncleared="" role="alert">
            , but its drafts could not be cleared
          </span>
        </Show>
      </span>
      <span class="flex-1" />
      <Button
        aria-label="Dismiss send result"
        class="shrink-0 text-muted-foreground/60 hover:text-foreground"
        onClick={() => props.onClose()}
        size={null}
        variant={null}
      >
        <XIcon class="size-3.5" />
      </Button>
    </output>
  )
}
