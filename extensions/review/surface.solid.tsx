import type { ConversationId } from '@earendil-works/pi-durable'
import { Virtualizer, parsePatchFiles } from '@pierre/diffs'
import type { FileDiffMetadata, FileDiffOptions } from '@pierre/diffs'
import {
  ArrowUpRightIcon,
  CheckIcon,
  ChevronDownIcon,
  Columns2Icon,
  Rows3Icon,
  XIcon,
} from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onSettled,
} from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Toggle, ToggleGroup } from '@/components/ui/toggle.solid.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.solid.tsx'
import {
  api,
  cn,
  errorMessage,
  keepLast,
  showSurface,
  switchConversation,
  useAction,
  useConversationId,
  useExtensionUiState,
  useStore,
  useViewport,
  writingAs,
} from '@/sdk/solid'
import { compareUrl } from '../../lib/compare.ts'
import { deadline } from '../../lib/timers.ts'
import { Address } from '../messages/ui.solid.tsx'
import { useGithubRepo } from '../workspaces/ui.solid.tsx'
import { draftsKey } from './comments.ts'
import { useDrafts } from './drafts.solid.tsx'
import type { Drafts } from './drafts.ts'
import { CommentedDiff } from './file-diff.solid.tsx'
import type { Writing } from './file-diff.solid.tsx'
import { Footer } from './footer.solid.tsx'
import { excerptFor } from './lines.ts'
import { useSpec, useTarget } from './link.solid.tsx'
import { setTarget } from './link-state.ts'
import type { ReviewTarget } from './link-state.ts'
import { Frame, Loading, Notice } from './parts.solid.tsx'
import { Recipient } from './recipient.solid.tsx'
import { DiffAction, RecipientAction, SendAction } from './refs.ts'
import type { ReviewDiff, ReviewFile } from './refs.ts'
import { Selector } from './selector.solid.tsx'

const themeCss = `
:host {
  --diffs-font-family: var(--font-mono);
  --diffs-header-font-family: var(--font-sans);
  --diffs-font-size: 12px;
  --diffs-line-height: 19px;
  --diffs-light-bg: var(--background);
  --diffs-dark-bg: var(--background);
  --diffs-addition-color-override: var(--diff-add);
  --diffs-deletion-color-override: var(--diff-del);
  --diffs-modified-color-override: var(--brand);
  --diffs-fg-number-override: color-mix(in oklab, var(--muted-foreground) 70%, transparent);
  --diffs-bg-separator-override: var(--muted);
  --diffs-bg-context-override: var(--card);
  --diffs-bg-selection-override: color-mix(in oklab, var(--brand) 22%, transparent);
  --diffs-bg-selection-number-override: color-mix(in oklab, var(--brand) 40%, transparent);
}
[data-gutter] [data-selected-line] { box-shadow: inset 3px 0 0 var(--brand); color: var(--foreground); }
[data-diffs-header] { border-bottom: 1px solid var(--border); font-size: 12.5px; }
[data-annotation-content] { background: var(--background); }
[data-utility-button] { background: var(--brand); color: var(--background); border-radius: 4px; }
`

const status: Record<ReviewFile['status'], [string, string]> = {
  added: ['A', 'text-diff-add'],
  deleted: ['D', 'text-diff-del'],
  modified: ['M', 'text-muted-foreground'],
  renamed: ['R', 'text-brand'],
  copied: ['C', 'text-brand'],
}

function byDirectory(files: ReviewFile[]) {
  const groups = Map.groupBy(files, (file) => {
    const slash = file.path.lastIndexOf('/')
    return slash === -1 ? '' : file.path.slice(0, slash)
  })
  return [...groups].toSorted(([a], [b]) => a.localeCompare(b))
}
const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const anchor = (path: string) => `review-file-${path}`
const pick = (path: string) =>
  document.getElementById(anchor(path))?.scrollIntoView({ block: 'start' })

function Counts(props: { additions: number; deletions: number }) {
  return (
    <span class="shrink-0 font-mono text-[11px] tabular-nums">
      <span class="text-diff-add">+{props.additions}</span>{' '}
      <span class="text-diff-del">−{props.deletions}</span>
    </span>
  )
}

function FileList(props: { files: ReviewFile[] }) {
  const groups = createMemo(() => byDirectory(props.files))
  return (
    <nav class="w-64 shrink-0 overflow-y-auto border-r border-border/70 bg-sidebar py-1.5">
      <For each={groups()} keyed={([directory]) => directory}>
        {(group) => (
          <div>
            {group()[0] && (
              <div
                class="truncate px-3 pt-1.5 pb-0.5 font-mono text-[10.5px] text-muted-foreground/80"
                title={group()[0]}
              >
                {group()[0]}/
              </div>
            )}
            <For each={group()[1]} keyed={(file) => file.path}>
              {(file) => (
                <Button
                  aria-label={`Jump to review file ${file().path}`}
                  class="flex w-full justify-start gap-2 px-3 py-0.5 text-left font-normal hover:bg-accent/60"
                  onClick={() => pick(file().path)}
                  size={null}
                  title={file().oldPath ? `${file().oldPath} → ${file().path}` : file().path}
                  variant={null}
                >
                  <span
                    class={cn('w-2.5 shrink-0 font-mono text-[10.5px]', status[file().status][1])}
                  >
                    {status[file().status][0]}
                  </span>
                  <span class="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground/90">
                    {fileName(file().path)}
                  </span>
                  {file().binary ? (
                    <span class="font-mono text-[10.5px] text-muted-foreground">bin</span>
                  ) : (
                    <Counts additions={file().additions} deletions={file().deletions} />
                  )}
                </Button>
              )}
            </For>
          </div>
        )}
      </For>
    </nav>
  )
}

function FileMenu(props: { files: ReviewFile[] }) {
  return (
    <DropdownMenu onAction={pick}>
      <DropdownMenuTrigger
        aria-label="Jump to a file in Review"
        class="flex h-8 w-full shrink-0 items-center gap-1.5 border-b border-border/70 bg-sidebar px-3 font-mono text-[12px] text-muted-foreground"
      >
        {props.files.length} file{props.files.length === 1 ? '' : 's'}
        <ChevronDownIcon class="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="max-h-[60vh] w-[calc(100vw-1rem)] overflow-y-auto">
        <For each={props.files} keyed={(file) => file.path}>
          {(file) => (
            <DropdownMenuItem class="gap-2 font-mono text-[12px]" value={file().path}>
              <span class={cn('w-2.5 shrink-0 text-[10.5px]', status[file().status][1])}>
                {status[file().status][0]}
              </span>
              <span class="min-w-0 flex-1 truncate">{file().path}</span>
              <Counts additions={file().additions} deletions={file().deletions} />
            </DropdownMenuItem>
          )}
        </For>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Placeholder(props: { file: ReviewFile }) {
  return (
    <div class="rounded-md border border-border/70 bg-card/40">
      <div class="flex items-center gap-2 border-b border-border/70 px-4 py-2 font-mono text-[12px]">
        <span class="min-w-0 flex-1 truncate">{props.file.path}</span>
        {!props.file.binary && (
          <Counts additions={props.file.additions} deletions={props.file.deletions} />
        )}
      </div>
      <p class="px-4 py-3 font-mono text-[11.5px] text-muted-foreground">
        {props.file.binary
          ? 'Binary file'
          : props.file.typeChanged
            ? 'Changed between a file and a symlink'
            : props.file.symlink
              ? 'New symlink'
              : 'Too large to show here'}
      </p>
    </div>
  )
}

function parse(diff: ReviewDiff) {
  const byPath = new Map<string, FileDiffMetadata>()
  for (const patch of parsePatchFiles(diff.patch, `${diff.base}:${diff.head ?? 'work'}`))
    for (const file of patch.files) byPath.set(file.name, file)
  return byPath
}

type DiffLayout = 'split' | 'unified'

function Scroller(props: { children: (virtualizer: Virtualizer) => JSX.Element }) {
  const virtualizer = new Virtualizer()
  let scroller!: HTMLDivElement
  let content!: HTMLDivElement
  onSettled(() => {
    virtualizer.setup(scroller, content)
    return () => virtualizer.cleanUp()
  })
  return (
    <div class="min-h-0 flex-1 overflow-y-auto" ref={scroller}>
      <div class="space-y-3 p-3 md:p-4" ref={content}>
        {props.children(virtualizer)}
      </div>
    </div>
  )
}

function Diffs(props: {
  diff: ReviewDiff
  parsed: Map<string, FileDiffMetadata>
  layout: DiffLayout
  phone: boolean
  drafts: Drafts
  update: (change: (drafts: Drafts) => Drafts) => boolean
  footer: JSX.Element
}) {
  const theme = useStore((state) => state.ui.theme)
  const [writing, setWriting] = createSignal<Writing>()
  const target = useTarget()
  const [marked, setMarked] = createSignal<ReviewTarget>()
  const options = createMemo<FileDiffOptions<undefined, undefined>>(() => ({
    theme: { dark: 'vitesse-dark', light: 'vitesse-light' },
    themeType: theme(),
    diffStyle: props.phone ? 'unified' : props.layout,
    diffIndicators: 'bars',
    overflow: props.phone ? 'wrap' : 'scroll',
    lineDiffType: 'word',
    hunkSeparators: 'line-info',
    unsafeCSS: themeCss,
  }))
  createEffect(
    () => ({ target: target(), diff: props.diff }),
    ({ target: at, diff }) => {
      if (!at) return undefined
      const clear = () => setTarget(undefined)
      if (!diff.files.some((file) => file.path === at.file)) {
        clear()
        return undefined
      }
      setMarked(at)
      pick(at.file)
      const side = at.side === 'old' ? 'deletions' : 'additions'
      const reach = () => {
        const root = document
          .getElementById(anchor(at.file))
          ?.querySelector('diffs-container')?.shadowRoot
        if (root) rendering.observe(root, { childList: true, subtree: true })
        const line =
          root?.querySelector(`[data-${side}] [data-line="${at.line}"]`) ??
          root?.querySelector(`[data-line="${at.line}"]`)
        if (!line) return
        consume()
        line.scrollIntoView({ block: 'center' })
      }
      const consume = () => {
        rendering.disconnect()
        giveUp()
        clear()
      }
      const rendering = new MutationObserver(reach)
      const giveUp = deadline(2000, consume)
      rendering.observe(document.body, { childList: true, subtree: true })
      reach()
      return () => {
        rendering.disconnect()
        giveUp()
      }
    },
  )
  const byFile = createMemo(() => Map.groupBy(props.drafts.comments, (draft) => draft.file))
  return (
    <>
      {!props.phone && <FileList files={props.diff.files} />}
      <div class="flex min-w-0 flex-1 flex-col">
        {props.phone && <FileMenu files={props.diff.files} />}
        {props.diff.truncated && (
          <p class="shrink-0 border-b border-border/70 bg-warning/10 px-4 py-1.5 font-mono text-[11.5px] text-warning">
            This diff is too large to show whole: later files are listed without their changes.
          </p>
        )}
        <Show when={props.phone ? 'phone' : 'desktop'} keyed>
          <Scroller>
            {(virtualizer) => (
              <For each={props.diff.files} keyed={(file) => file.path}>
                {(file) => (
                  <section class="scroll-mt-3" id={anchor(file().path)}>
                    <Show
                      when={props.parsed.get(file().path)}
                      fallback={<Placeholder file={file()} />}
                    >
                      {(meta) => (
                        <CommentedDiff
                          drafts={byFile().get(file().path) ?? []}
                          marked={marked()?.file === file().path ? marked() : undefined}
                          meta={meta()}
                          onWrite={setWriting}
                          options={options()}
                          update={props.update}
                          virtualizer={virtualizer}
                          writing={writing()}
                        />
                      )}
                    </Show>
                  </section>
                )}
              </For>
            )}
          </Scroller>
        </Show>
        {props.footer}
      </div>
    </>
  )
}

type SendOutcome = { conversation: ConversationId } | { error: string }

function Sent(props: { sent: SendOutcome; onClose: () => void }) {
  const error = () => ('error' in props.sent ? props.sent.error : undefined)
  const recipient = () => ('conversation' in props.sent ? props.sent.conversation : undefined)
  return (
    <output
      class="flex shrink-0 items-center gap-2 border-t border-border/70 bg-sidebar px-3 py-2 font-mono text-[11.5px] md:px-4"
      data-review-sent=""
    >
      <Show
        when={recipient()}
        fallback={<span class="min-w-0 flex-1 text-error">Not sent: {error()}</span>}
      >
        {(id) => (
          <>
            <CheckIcon class="size-3.5 shrink-0 text-success" />
            <span class="shrink-0 text-muted-foreground">Sent to</span>
            <Button
              aria-label={`Open review recipient #${id()}`}
              class="flex min-w-0 font-normal text-foreground/90 hover:underline"
              onClick={() => {
                switchConversation(id())
                showSurface('agent')
              }}
              size={null}
              variant={null}
            >
              <Address id={id()} />
            </Button>
            <span class="flex-1" />
          </>
        )}
      </Show>
      <Button
        aria-label="Dismiss review send result"
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

const layouts = [
  { name: 'split', icon: Columns2Icon, label: 'Side by side diff' },
  { name: 'unified', icon: Rows3Icon, label: 'Unified diff' },
] as const

type Scope = { spec: string; conversation?: ConversationId }

export default function ReviewSurface() {
  const [spec, setSpec] = useSpec()
  const id = useConversationId()
  const scope = createMemo(() => ({ spec: spec(), conversation: id() }))
  const [sent, setSent] = createSignal<SendOutcome>()
  const [sending, setSending] = createSignal(false)
  return (
    <Show when={scope()} keyed>
      {(current) => (
        <ReviewScope
          scope={current}
          sending={sending()}
          sent={sent()}
          setSending={setSending}
          setSent={setSent}
          setSpec={setSpec}
        />
      )}
    </Show>
  )
}

function ReviewScope(props: {
  scope: Scope
  sending: boolean
  sent?: SendOutcome
  setSending: (sending: boolean) => void
  setSent: (outcome: SendOutcome | undefined) => void
  setSpec: (spec: string) => void
}) {
  const [stored, setLayout] = useExtensionUiState('layout', 'split')
  const layout = () => (stored() === 'unified' ? 'unified' : 'split')
  const viewport = useViewport()
  const phone = () => viewport() === 'phone'
  const args = {
    get spec() {
      return props.scope.spec
    },
    get conversation() {
      return props.scope.conversation
    },
  }
  const diff = useAction(DiffAction, args, { onError: keepLast })
  const github = useGithubRepo()
  const [drafts, update] = useDrafts(() => draftsKey(props.scope.spec, props.scope.conversation))
  const suggested = useAction(RecipientAction, args, { onError: keepLast })
  const to = () => drafts().to ?? suggested.data()?.conversation
  const data = createMemo(() => (diff.data()?.spec === props.scope.spec ? diff.data() : undefined))
  const setSpec = (spec: string) => props.setSpec(spec)
  createEffect(
    () => ({ next: diff.data()?.spec, requested: props.scope.spec }),
    ({ next, requested }) => {
      if (next && next !== requested) writingAs('app', () => setSpec(next))
    },
  )
  const parsed = createMemo(() => {
    const current = data()
    return current ? parse(current) : new Map<string, FileDiffMetadata>()
  })
  const totals = createMemo(() =>
    data()?.files.reduce(
      (sum, file) => ({
        additions: sum.additions + file.additions,
        deletions: sum.deletions + file.deletions,
      }),
      { additions: 0, deletions: 0 },
    ),
  )
  const compare = () => {
    const repo = github()
    const diffData = data()
    return repo &&
      diffData?.base &&
      diffData.head &&
      (diffData.kind === 'commit' || diffData.kind === 'range')
      ? compareUrl(repo, diffData.base, diffData.head)
      : undefined
  }
  const send = async (source: Parameters<typeof writingAs>[0]) => {
    const conversation = to()
    if (conversation === undefined) return
    const { comments, note } = drafts()
    const spec = props.scope.spec
    const files = parsed()
    const setSent = props.setSent
    const setSending = props.setSending
    setSending(true)
    setSent(undefined)
    const submitted = new Set(comments.map((draft) => draft.id))
    try {
      const result = await api.action(SendAction, {
        conversation,
        spec,
        comments: comments.map(({ id: _id, ...comment }) => ({
          ...comment,
          excerpt: excerptFor(files.get(comment.file), comment),
        })),
        ...(note.trim() && { note }),
      })
      writingAs(source, () => {
        update((all) => ({
          ...all,
          comments: all.comments.filter((draft) => !submitted.has(draft.id)),
          note: all.note === note ? '' : all.note,
        }))
      })
      setSent(result)
    } catch (failure) {
      setSent({ error: errorMessage(failure) })
    } finally {
      setSending(false)
    }
  }
  const sentError = () => (props.sent && 'error' in props.sent ? props.sent.error : undefined)
  return (
    <Frame
      controls={
        <>
          <Selector
            conversation={props.scope.conversation}
            spec={props.scope.spec}
            title={data()?.title}
            onChange={(next) => {
              props.setSent(undefined)
              props.setSpec(next)
            }}
          />
          <Show when={totals()}>
            {(total) => (
              <span class="shrink-0 font-mono text-[11.5px] text-muted-foreground">
                <span class="text-diff-add">+{total().additions}</span>{' '}
                <span class="text-diff-del">−{total().deletions}</span>
                <span class="max-md:hidden">
                  {' '}
                  · {data()?.files.length} file{data()?.files.length === 1 ? '' : 's'}
                </span>
              </span>
            )}
          </Show>
          {!phone() && (
            <ToggleGroup
              aria-label="Diff layout"
              bind={[() => [layout()], ([next]) => next && setLayout(next)]}
              class="flex shrink-0 items-center gap-0 rounded-md border border-border/70 p-0.5"
              deselectable={false}
            >
              <For each={layouts}>
                {(choice) => (
                  <Toggle
                    aria-label={choice.label}
                    value={choice.name}
                    class="flex h-6 gap-1 rounded-sm px-1.5 font-mono text-[11px] font-normal text-muted-foreground transition-colors hover:text-foreground"
                    size={null}
                    title={choice.label}
                    variant={null}
                  >
                    <choice.icon class="size-3.5" />
                    <span class="max-lg:hidden">{choice.name}</span>
                  </Toggle>
                )}
              </For>
            </ToggleGroup>
          )}
          <span class="ml-auto" />
          {(drafts().comments.length > 0 || drafts().to !== undefined) && (
            <Recipient onChange={(id) => update((all) => ({ ...all, to: id }))} value={to()} />
          )}
          <Show when={compare()}>
            {(url) => (
              <a
                class="inline-flex shrink-0 items-center gap-0.5 font-mono text-[11.5px] text-muted-foreground hover:text-foreground hover:underline"
                href={url()}
                rel="noreferrer"
                target="_blank"
                title="Compare on DiffsHub"
              >
                DiffsHub
                <ArrowUpRightIcon class="size-3 opacity-60" />
              </a>
            )}
          </Show>
        </>
      }
    >
      <Switch fallback={<Loading />}>
        <Match when={data()}>
          {(selected) => (
            <Show
              when={selected().files.length}
              fallback={<Notice>no changes · {selected().title}</Notice>}
            >
              <Diffs
                diff={selected()}
                parsed={parsed()}
                drafts={drafts()}
                footer={
                  <Show
                    when={drafts().comments.length}
                    fallback={
                      <Show when={props.sent}>
                        {(sent) => <Sent sent={sent()} onClose={() => props.setSent(undefined)} />}
                      </Show>
                    }
                  >
                    <Footer
                      drafts={drafts()}
                      error={sentError()}
                      onSend={send}
                      sending={props.sending}
                      update={update}
                    />
                  </Show>
                }
                layout={layout()}
                phone={phone()}
                update={update}
              />
            </Show>
          )}
        </Match>
        <Match when={!diff.loading() && diff.error()}>
          {(error) => (
            <Notice>
              <span class="text-error">{errorMessage(error())}</span>
            </Notice>
          )}
        </Match>
      </Switch>
    </Frame>
  )
}
