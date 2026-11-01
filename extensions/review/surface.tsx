import { parsePatchFiles } from '@pierre/diffs'
import { FileDiff, Virtualizer } from '@pierre/diffs/react'
import type {
  DiffLineAnnotation,
  FileDiffMetadata,
  FileDiffOptions,
  SelectedLineRange,
} from '@pierre/diffs/react'
import {
  ArrowUpRightIcon,
  CheckIcon,
  ChevronDownIcon,
  Columns2Icon,
  Rows3Icon,
  XIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  api,
  cn,
  errorMessage,
  useAction,
  useExtensionUiState,
  useStore,
  useUltimate,
  useViewport,
} from '@/sdk'
import { Address } from '../messages/ui.tsx'
import { compareUrl } from '../../lib/compare.ts'
import { useGithubRepo } from '../workspaces/ui.tsx'
import { Composer, DraftCard } from './comment.tsx'
import { draftsKey } from './comments.ts'
import { useDrafts } from './drafts.ts'
import type { Draft, Drafts } from './drafts.ts'
import { Footer } from './footer.tsx'
import { commentRange, excerptFor } from './lines.ts'
import type { CommentLines } from './lines.ts'
import { reachedTarget, useSpec, useTarget } from './link.tsx'
import type { ReviewTarget } from './link.tsx'
import { Frame, Loading, Notice } from './parts.tsx'
import { Recipient } from './recipient.tsx'
import { DiffAction, RecipientAction, SendAction } from './refs.ts'
import type { ReviewDiff, ReviewFile } from './refs.ts'
import { Selector } from './selector.tsx'

/**
 * Our theme for the viewer, inside its shadow root: our page's tokens inherit into it, so the code takes our mono
 * font, our background and our add/del colours in both themes, with the vitesse themes for syntax.
 */
const themeCss = `
:host {
  --diffs-font-family: var(--font-mono);
  --diffs-header-font-family: var(--font-sans);
  --diffs-font-size: 0.75rem;
  --diffs-line-height: 1.1875rem;
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
/* One continuous bar down the selected line numbers, while dragging and after. */
[data-gutter] [data-selected-line] { box-shadow: inset 3px 0 0 var(--brand); color: var(--foreground); }
[data-diffs-header] { border-bottom: 1px solid var(--border); font-size: 0.7813rem; }
[data-annotation-content] { background: var(--background); }
[data-utility-button] { background: var(--brand); color: var(--background); border-radius: 4px; }
`

/** A comment being written: new on `range`, or an edit of draft `id`. */
type Writing = { file: string; range: SelectedLineRange; id?: string }
/** What an annotation under a line holds: the composer, or a saved draft. */
type Note = { composer: true } | { draft: Draft }

const sideOf = (side: 'old' | 'new') => (side === 'old' ? 'deletions' : 'additions')
const lastLine = (range: SelectedLineRange) => Math.max(range.start, range.end)
const rangeOf = (draft: CommentLines): SelectedLineRange => ({
  start: draft.start,
  end: draft.end,
  side: sideOf(draft.side),
})

const status: Record<ReviewFile['status'], [string, string]> = {
  added: ['A', 'text-diff-add'],
  deleted: ['D', 'text-diff-del'],
  modified: ['M', 'text-muted-foreground'],
  renamed: ['R', 'text-brand'],
  copied: ['C', 'text-brand'],
}

/** Files by their directory, directories in path order, files in diff order within each. */
function byDirectory(files: ReviewFile[]) {
  const groups = Map.groupBy(files, (file) => {
    const slash = file.path.lastIndexOf('/')
    return slash === -1 ? '' : file.path.slice(0, slash)
  })
  return [...groups].toSorted(([a], [b]) => a.localeCompare(b))
}
const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const anchor = (path: string) => `review-file-${path}`

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono text-[0.6875rem] tabular-nums">
      <span className="text-diff-add">+{additions}</span>{' '}
      <span className="text-diff-del">−{deletions}</span>
    </span>
  )
}

function FileList({ files, onPick }: { files: ReviewFile[]; onPick: (path: string) => void }) {
  return (
    <nav className="w-64 shrink-0 overflow-y-auto border-r border-border/70 bg-sidebar py-1.5">
      {byDirectory(files).map(([directory, items]) => (
        <div key={directory}>
          {directory && (
            <div
              className="truncate px-3 pt-1.5 pb-0.5 font-mono text-[0.6562rem] text-muted-foreground"
              title={directory}
            >
              {directory}/
            </div>
          )}
          {items.map((file) => {
            const [letter, tone] = status[file.status]
            return (
              <button
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-0.5 text-left hover:bg-accent/60"
                key={file.path}
                onClick={() => onPick(file.path)}
                title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                type="button"
              >
                <span className={cn('w-2.5 shrink-0 font-mono text-[0.6562rem]', tone)}>
                  {letter}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[0.75rem] text-foreground/90">
                  {fileName(file.path)}
                </span>
                {file.binary ? (
                  <span className="font-mono text-[0.6562rem] text-muted-foreground">bin</span>
                ) : (
                  <Counts additions={file.additions} deletions={file.deletions} />
                )}
              </button>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

/** The file list as a dropdown, on a phone. */
function FileMenu({ files, onPick }: { files: ReviewFile[]; onPick: (path: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-8 w-full shrink-0 cursor-pointer items-center gap-1.5 border-b border-border/70 bg-sidebar px-3 font-mono text-[0.75rem] text-muted-foreground">
        {files.length} file{files.length === 1 ? '' : 's'}
        <ChevronDownIcon className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[60vh] w-[calc(100vw-1rem)] overflow-y-auto"
      >
        {files.map((file) => (
          <DropdownMenuItem
            className="gap-2 font-mono text-[0.75rem]"
            key={file.path}
            onSelect={() => onPick(file.path)}
          >
            <span className={cn('w-2.5 shrink-0 text-[0.6562rem]', status[file.status][1])}>
              {status[file.status][0]}
            </span>
            <span className="min-w-0 flex-1 truncate">{file.path}</span>
            <Counts additions={file.additions} deletions={file.deletions} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A file whose hunks were left out: binary, a type change, a new symlink, or too large to show. */
function Placeholder({ file }: { file: ReviewFile }) {
  return (
    <div className="rounded-md border border-border/70 bg-card/40">
      <div className="flex items-center gap-2 border-b border-border/70 px-4 py-2 font-mono text-[0.75rem]">
        <span className="min-w-0 flex-1 truncate">{file.path}</span>
        {!file.binary && <Counts additions={file.additions} deletions={file.deletions} />}
      </div>
      <p className="px-4 py-3 font-mono text-[0.7188rem] text-muted-foreground">
        {file.binary
          ? 'Binary file'
          : file.typeChanged
            ? 'Changed between a file and a symlink'
            : file.symlink
              ? 'New symlink'
              : 'Too large to show here'}
      </p>
    </div>
  )
}

/** One file's diff, with its draft comments under their lines and the composer under a selection. */
function CommentedDiff({
  meta,
  options,
  drafts,
  writing,
  marked,
  onWrite,
  update,
}: {
  meta: FileDiffMetadata
  options: FileDiffOptions<Note, undefined>
  drafts: Draft[]
  writing?: Writing
  marked?: ReviewTarget
  onWrite: (writing: Writing | undefined) => void
  update: (change: (drafts: Drafts) => Drafts) => boolean
}) {
  const mine = writing?.file === meta.name ? writing : undefined
  const annotations: DiffLineAnnotation<Note>[] = drafts
    .filter((draft) => draft.id !== mine?.id)
    .map((draft) => ({ side: sideOf(draft.side), lineNumber: draft.end, metadata: { draft } }))
  if (mine)
    annotations.push({
      side: mine.range.endSide ?? mine.range.side ?? 'additions',
      lineNumber: lastLine(mine.range),
      metadata: { composer: true },
    })
  // The range under the pointer while the user drags or shift-clicks: the viewer only proposes a controlled selection,
  // so it shows as it grows only once it comes back in `selectedLines`.
  const [dragging, setDragging] = useState<SelectedLineRange | null>(null)
  const selected: SelectedLineRange | null =
    dragging ??
    (mine
      ? mine.range
      : marked
        ? { start: marked.line, end: marked.line, side: sideOf(marked.side ?? 'new') }
        : null)
  const fileOptions = useMemo<FileDiffOptions<Note, undefined>>(
    () => ({
      ...options,
      enableLineSelection: true,
      enableGutterUtility: true,
      onLineSelectionStart: setDragging,
      onLineSelectionChange: setDragging,
      onLineSelectionEnd: (range) => {
        setDragging(null)
        // Clicking the one selected line again unselects it: the composer closes.
        onWrite(range ? { file: meta.name, range } : undefined)
      },
      // The gutter `+` is not a line selection to the viewer: it reports its line (or a range dragged from it) here.
      onGutterUtilityClick: (range) => onWrite({ file: meta.name, range }),
    }),
    [options, meta.name, onWrite],
  )
  const editing = mine?.id ? drafts.find((draft) => draft.id === mine.id) : undefined
  return (
    <FileDiff<Note>
      className="block overflow-hidden rounded-md border border-border/70"
      fileDiff={meta}
      lineAnnotations={annotations}
      options={fileOptions}
      renderAnnotation={(annotation) => {
        const note = annotation.metadata
        if ('draft' in note)
          return (
            <DraftCard
              comment={note.draft}
              onDelete={() =>
                update((all) => ({
                  ...all,
                  comments: all.comments.filter((draft) => draft.id !== note.draft.id),
                }))
              }
              onEdit={() =>
                onWrite({ file: meta.name, range: rangeOf(note.draft), id: note.draft.id })
              }
            />
          )
        if (!mine) return null
        return (
          <Composer
            comment={commentRange(meta, mine.range)}
            initial={editing?.text}
            key={`${mine.id ?? 'new'}:${mine.range.start}:${mine.range.end}`}
            onCancel={() => onWrite(undefined)}
            onSubmit={(text) => {
              const kept = update((all) => ({
                ...all,
                comments: editing
                  ? all.comments.map((draft) =>
                      draft.id === editing.id ? { ...draft, text } : draft,
                    )
                  : [
                      ...all.comments,
                      { ...commentRange(meta, mine.range), text, id: crypto.randomUUID() },
                    ],
              }))
              if (kept) onWrite(undefined)
              return kept
            }}
            submit={editing ? 'Save' : 'Add to review'}
          />
        )
      }}
      selectedLines={selected}
    />
  )
}

/** Each file's parsed diff, by path: what the viewer renders and what a sent comment quotes. */
function parse(diff: ReviewDiff) {
  const byPath = new Map<string, FileDiffMetadata>()
  for (const patch of parsePatchFiles(diff.patch, `${diff.base}:${diff.head ?? 'work'}`))
    for (const file of patch.files) byPath.set(file.name, file)
  return byPath
}

function Diffs({
  diff,
  parsed,
  layout,
  phone,
  drafts,
  update,
  footer,
}: {
  diff: ReviewDiff
  parsed: Map<string, FileDiffMetadata>
  layout: 'split' | 'unified'
  phone: boolean
  drafts: Drafts
  update: (change: (drafts: Drafts) => Drafts) => boolean
  footer: ReactNode
}) {
  const theme = useStore((state) => state.ui.theme)
  const [writing, setWriting] = useState<Writing>()
  const target = useTarget()
  const [marked, setMarked] = useState<ReviewTarget>()
  const options = useMemo<FileDiffOptions<Note, undefined>>(
    () => ({
      theme: { dark: 'vitesse-dark', light: 'vitesse-light' },
      themeType: theme,
      diffStyle: phone ? 'unified' : layout,
      diffIndicators: 'bars',
      overflow: phone ? 'wrap' : 'scroll',
      lineDiffType: 'word',
      hunkSeparators: 'line-info',
      unsafeCSS: themeCss,
    }),
    [theme, layout, phone],
  )
  const pick = (path: string) =>
    document.getElementById(anchor(path))?.scrollIntoView({ block: 'start' })
  // A link to a line scrolls to its file, then to the line once the file has rendered it.
  // It stays the target until the line is on screen (or never renders): only then is it consumed.
  useEffect(() => {
    if (!target) return undefined
    if (!diff.files.some((file) => file.path === target.file)) {
      reachedTarget()
      return undefined
    }
    setMarked(target)
    pick(target.file)
    let tries = 0
    const timer = setInterval(() => {
      const host = document.getElementById(anchor(target.file))?.querySelector('diffs-container')
      const side = target.side === 'old' ? 'deletions' : 'additions'
      const line =
        host?.shadowRoot?.querySelector(`[data-${side}] [data-line="${target.line}"]`) ??
        host?.shadowRoot?.querySelector(`[data-line="${target.line}"]`)
      if (!line && ++tries <= 40) return
      clearInterval(timer)
      line?.scrollIntoView({ block: 'center' })
      reachedTarget()
    }, 50)
    return () => clearInterval(timer)
  }, [target, diff])
  const byFile = Map.groupBy(drafts.comments, (draft) => draft.file)
  return (
    <>
      {!phone && <FileList files={diff.files} onPick={pick} />}
      <div className="flex min-w-0 flex-1 flex-col">
        {phone && <FileMenu files={diff.files} onPick={pick} />}
        {diff.truncated && (
          <p className="shrink-0 border-b border-border/70 bg-warning/10 px-4 py-1.5 font-mono text-[0.7188rem] text-warning">
            This diff is too large to show whole: later files are listed without their changes.
          </p>
        )}
        <Virtualizer
          className="min-h-0 flex-1 overflow-y-auto"
          contentClassName="space-y-3 p-3 md:p-4"
          key={`${diff.spec}:${phone}`}
        >
          {diff.files.map((file) => {
            const meta = parsed.get(file.path)
            return (
              <section className="scroll-mt-3" id={anchor(file.path)} key={file.path}>
                {meta ? (
                  <CommentedDiff
                    drafts={byFile.get(file.path) ?? []}
                    marked={marked?.file === file.path ? marked : undefined}
                    meta={meta}
                    onWrite={setWriting}
                    options={options}
                    update={update}
                    writing={writing}
                  />
                ) : (
                  <Placeholder file={file} />
                )}
              </section>
            )
          })}
        </Virtualizer>
        {footer}
      </div>
    </>
  )
}

/** Where the last review went, with a link to its conversation, or why it did not. */
function Sent({
  sent,
  onOpen,
  onClose,
}: {
  sent: { conversation: number } | { error: string }
  onOpen: (id: number) => void
  onClose: () => void
}) {
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-t border-border/70 bg-sidebar px-3 py-2 font-mono text-[0.7188rem] md:px-4"
      data-review-sent=""
      role="status"
    >
      {'error' in sent ? (
        <span className="min-w-0 flex-1 text-error">Not sent: {sent.error}</span>
      ) : (
        <>
          <CheckIcon className="size-3.5 shrink-0 text-success" />
          <span className="shrink-0 text-muted-foreground">Sent to</span>
          <button
            className="flex min-w-0 cursor-pointer text-foreground/90 hover:underline"
            onClick={() => onOpen(sent.conversation)}
            type="button"
          >
            <Address id={sent.conversation} />
          </button>
          <span className="flex-1" />
        </>
      )}
      <button
        aria-label="Dismiss"
        className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
        onClick={onClose}
        type="button"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  )
}

/** The Review surface: a spec's diff, its files on the left and their changes stacked on the right. */
export default function ReviewSurface() {
  const [spec, setSpec] = useSpec()
  const [stored, setLayout] = useExtensionUiState('layout', 'split')
  const layout = stored === 'unified' ? 'unified' : 'split'
  const phone = useViewport() === 'phone'
  // The diff runs in the project checkout: no conversation's worktree, so drafts are the project's for this spec.
  const args: { spec: string; conversation?: number } = { spec }
  const diff = useAction(DiffAction, args, { onError: () => undefined })
  const github = useGithubRepo()
  const [drafts, update] = useDrafts(draftsKey(spec, args.conversation))
  const suggested = useAction(RecipientAction, { spec }, { onError: () => undefined })
  const to = drafts.to ?? suggested.data?.conversation
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<{ conversation: number } | { error: string }>()
  const { switchConversation, showSurface } = useUltimate()
  const data = diff.data?.spec === spec ? diff.data : undefined
  const parsed = useMemo(() => (data ? parse(data) : new Map<string, FileDiffMetadata>()), [data])
  const send = async () => {
    if (to === undefined) return
    setSending(true)
    setSent(undefined)
    // What goes out: drafts added or a note changed while it is on its way stay pending.
    const ids = new Set(drafts.comments.map((draft) => draft.id))
    const note = drafts.note
    try {
      const result = await api.action(SendAction, {
        conversation: to,
        spec,
        // Drafts keep no excerpt: it is read now from the diff on screen.
        comments: drafts.comments.map(({ id: _id, ...comment }) => ({
          ...comment,
          excerpt: excerptFor(parsed.get(comment.file), comment),
        })),
        ...(note.trim() && { note }),
      })
      update((all) => ({
        ...all,
        comments: all.comments.filter((draft) => !ids.has(draft.id)),
        note: all.note === note ? '' : all.note,
      }))
      setSent(result)
    } catch (failure) {
      setSent({ error: errorMessage(failure) })
    } finally {
      setSending(false)
    }
  }
  const footer =
    drafts.comments.length > 0 ? (
      <Footer
        drafts={drafts}
        error={sent && 'error' in sent ? sent.error : undefined}
        onSend={() => void send()}
        sending={sending}
        update={update}
      />
    ) : sent ? (
      <Sent
        onClose={() => setSent(undefined)}
        onOpen={(id) => {
          switchConversation(id)
          showSurface('agent')
        }}
        sent={sent}
      />
    ) : null
  const totals = data?.files.reduce(
    (sum, file) => ({
      additions: sum.additions + file.additions,
      deletions: sum.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  )
  // A worktree branch is local until it lands, so only commits and ranges (landings) are on GitHub to compare.
  const compare =
    github && data?.base && data.head && (data.kind === 'commit' || data.kind === 'range')
      ? compareUrl(github, data.base, data.head)
      : undefined
  return (
    <Frame
      controls={
        <>
          <Selector
            onChange={(next) => {
              setSent(undefined)
              setSpec(next)
            }}
            spec={spec}
            title={data?.title}
          />
          {data && totals && (
            <span className="shrink-0 font-mono text-[0.7188rem] text-muted-foreground">
              <span className="text-diff-add">+{totals.additions}</span>{' '}
              <span className="text-diff-del">−{totals.deletions}</span>
              <span className="max-md:hidden">
                {' '}
                · {data.files.length} file{data.files.length === 1 ? '' : 's'}
              </span>
            </span>
          )}
          {!phone && (
            <div className="flex shrink-0 items-center rounded-md border border-border/70 p-0.5">
              {(
                [
                  ['split', Columns2Icon],
                  ['unified', Rows3Icon],
                ] as const
              ).map(([name, Icon]) => (
                <button
                  aria-pressed={layout === name}
                  className={cn(
                    'flex h-6 cursor-pointer items-center gap-1 rounded-sm px-1.5 font-mono text-[0.6875rem] text-muted-foreground transition-colors',
                    layout === name ? 'bg-accent text-foreground' : 'hover:text-foreground',
                  )}
                  key={name}
                  onClick={() => setLayout(name)}
                  title={`${name === 'split' ? 'Side by side' : 'Unified'} diff`}
                  type="button"
                >
                  <Icon className="size-3.5" />
                  <span className="max-lg:hidden">{name}</span>
                </button>
              ))}
            </div>
          )}
          <span className="ml-auto" />
          {(drafts.comments.length > 0 || drafts.to !== undefined) && (
            <Recipient onChange={(id) => update((all) => ({ ...all, to: id }))} value={to} />
          )}
          {compare && (
            <a
              className="inline-flex shrink-0 items-center gap-0.5 font-mono text-[0.7188rem] text-muted-foreground hover:text-foreground hover:underline"
              href={compare}
              rel="noreferrer"
              target="_blank"
              title="Compare on DiffsHub"
            >
              DiffsHub
              <ArrowUpRightIcon className="size-3 opacity-60" />
            </a>
          )}
        </>
      }
    >
      {data ? (
        data.files.length === 0 ? (
          <Notice>no changes · {data.title}</Notice>
        ) : (
          <Diffs
            diff={data}
            parsed={parsed}
            drafts={drafts}
            footer={footer}
            layout={layout}
            phone={phone}
            update={update}
          />
        )
      ) : diff.error && !diff.loading ? (
        <Notice>
          <span className="text-error">{errorMessage(diff.error)}</span>
        </Notice>
      ) : (
        <Loading />
      )}
    </Frame>
  )
}
