import type { EntryRecord } from '@earendil-works/pi-durable'
import { File, GitCommit, GitFork, History } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { createSignal, For, Show } from 'solid-js'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import { Checkbox } from '@/components/ui/checkbox.solid.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog.solid.tsx'
import {
  Card,
  Fold,
  renderEntry,
  api,
  errorMessage,
  ROOT,
  switchConversation,
  useAction,
  useConversationId,
  useDocOf,
  writingAs,
} from '@/sdk/solid'
import { ConversationRef } from '../conversations/ui.solid.tsx'
import { RewoundEntry, RewoundDependentEntry } from './entries.ts'
import { RewindAction, RewindPreviewAction, RootsDoc } from './refs.ts'
import type { RewindDependent, RewindFile } from './refs.ts'

const via = { subagent: 'subagent', branch: 'branch', message: 'messaged' } as const

function Files(props: { files: readonly RewindFile[] }) {
  return (
    <ul class="flex flex-col gap-0.5 font-mono text-[11.5px]">
      <For each={props.files}>
        {(file) => (
          <li class="flex min-w-0 items-center gap-2">
            <File class="size-3 shrink-0 text-muted-foreground" />
            <span class="min-w-0 truncate" title={file.path}>
              {file.path}
            </span>
            <span class="ml-auto shrink-0 tabular-nums">
              {file.outside ? (
                <span class="text-muted-foreground">outside the checkout</span>
              ) : file.untracked ? (
                <span class="text-muted-foreground">new</span>
              ) : file.added === undefined ? (
                <span class="text-muted-foreground">changed</span>
              ) : (
                <>
                  <span class="text-success">+{file.added}</span>{' '}
                  <span class="text-error">−{file.removed ?? 0}</span>
                </>
              )}
            </span>
          </li>
        )}
      </For>
    </ul>
  )
}

function Dependents(props: { dependents: readonly RewindDependent[] }) {
  return (
    <ul class="flex flex-col gap-0.5 font-mono text-[11.5px]">
      <For each={props.dependents}>
        {(dependent) => (
          <li class="flex min-w-0 items-center gap-2">
            <GitFork class="size-3 shrink-0 text-muted-foreground" />
            <ConversationRef id={dependent.id} />
            <span class="ml-auto shrink-0 text-muted-foreground">{via[dependent.via]}</span>
          </li>
        )}
      </For>
    </ul>
  )
}

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <div class="mt-4">
      <p class="mb-1.5 section-label">{props.title}</p>
      {props.children}
    </div>
  )
}

function GoBackDialog(props: { entry: EntryRecord; onClose: () => void }) {
  const preview = useAction(RewindPreviewAction, {
    get conversation() {
      return props.entry.conversationId
    },
    get at() {
      return props.entry.id
    },
  })
  const [summarize, setSummarize] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const refused = () => preview.data()?.refused
  const pendingLabel = () => (summarize() ? 'Summarizing…' : 'Going back…')

  async function go(source: string) {
    const { conversationId: conversation, id: at } = props.entry
    const close = props.onClose
    setError(undefined)
    try {
      await api.action(RewindAction, { conversation, at, summarize: summarize() })
    } catch (failure) {
      setError(errorMessage(failure))
      return
    }
    writingAs(source, close)
  }

  return (
    <Dialog onOpenChange={(open) => !open && props.onClose()} open>
      <DialogContent class="gap-0 overflow-hidden p-0 sm:max-w-md" showCloseButton={false}>
        <div class="max-h-[70vh] overflow-y-auto px-5 pt-5 pb-4" data-lineage-rewind-dialog>
          <DialogTitle class="text-[14px] font-medium">
            Go back to #{props.entry.conversationId}/{props.entry.id}?
          </DialogTitle>
          <DialogDescription class="mt-2 text-[13px] leading-relaxed break-words">
            <Show
              when={refused()}
              fallback={
                <>
                  What came after this point leaves the context and stays readable, folded. Files
                  and commits stay as they are; the next message you send continues from here.
                </>
              }
            >
              <span class="text-error" data-lineage-rewind-refused>
                {refused()}
              </span>
            </Show>
          </DialogDescription>
          <Show when={!preview.data() && !preview.error()}>
            <p class="mt-4 font-mono text-[11px] text-muted-foreground">Reading what changed…</p>
          </Show>
          <Show when={!refused() && preview.data()}>
            {(result) => (
              <>
                <p class="mt-3 font-mono text-[11px] text-muted-foreground">
                  {result().steps} step{result().steps === 1 ? '' : 's'} set aside
                  {result().commits.length
                    ? ` · ${result().commits.length} commit${result().commits.length === 1 ? '' : 's'} since`
                    : ''}
                </p>
                <Section title="Files changed since (kept in the worktree)">
                  <Show
                    when={result().files.length > 0}
                    fallback={<p class="text-[12.5px] text-muted-foreground">No changes.</p>}
                  >
                    <Files files={result().files} />
                  </Show>
                </Section>
                <Show when={result().dependents.length > 0}>
                  <Section title="Built on this path">
                    <Dependents dependents={result().dependents} />
                    <p class="mt-1.5 text-[12px] text-muted-foreground">
                      They keep running on their own and get a marker.
                    </p>
                  </Section>
                </Show>
                <label class="mt-4 flex items-start gap-2.5 text-[13px]">
                  <Checkbox
                    bind={[summarize, setSummarize]}
                    class="mt-0.5"
                    disabled={!result().summaryModel}
                  />
                  <span>
                    Summarize what came after this point
                    <span class="block text-[12px] text-muted-foreground">
                      {result().summaryModel
                        ? 'The summary model adds decisions, results and open threads to the note.'
                        : 'No summary model is available; the note lists the files.'}
                    </span>
                  </span>
                </label>
              </>
            )}
          </Show>
          <Show when={error()}>
            <p class="mt-3 font-mono text-[12px] break-words text-error">{error()}</p>
          </Show>
        </div>
        <div class="flex justify-end gap-2 border-t border-border/70 bg-sidebar px-5 py-3">
          <Button onClick={() => props.onClose()} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            aria-label="Confirm go back"
            disabled={!preview.data() || !!refused()}
            onClick={(_, details) => go(details.source)}
            pendingAnnouncement={pendingLabel()}
            size="sm"
          >
            {(state) => (state.pending ? pendingLabel() : 'Go back')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function GoBackAction(props: { entry: EntryRecord }) {
  const roots = useDocOf(() => ROOT, RootsDoc)
  const shown = useConversationId()
  const [open, setOpen] = createSignal(false)
  return (
    <Show
      when={
        shown() === props.entry.conversationId &&
        roots()?.roots.includes(props.entry.conversationId) === false
      }
    >
      <Button
        aria-label={`Go back to message #${props.entry.id}`}
        class="rounded p-0.5 transition-colors hover:text-foreground [&_svg]:size-3"
        data-lineage-go-back={props.entry.id}
        onClick={() => setOpen(true)}
        size={null}
        title="Go back to here"
        variant={null}
      >
        <History class="size-3" />
      </Button>
      <Show when={open()}>
        <GoBackDialog entry={props.entry} onClose={() => setOpen(false)} />
      </Show>
    </Show>
  )
}

export const Rewound = renderEntry(RewoundEntry, (props) => {
  const data = () => props.entry.data
  return (
    <Fold
      card={props.entry.id}
      label={`Toggle rewind note #${props.entry.id}`}
      summary={
        <>
          <History class="size-3 shrink-0 text-brand" />
          <span class="shrink-0">
            Went back to #{props.entry.conversationId}/{data().at} · {data().files.length} file
            {data().files.length === 1 ? '' : 's'} changed
          </span>
        </>
      }
    >
      <Card data-lineage-rewound={data().at}>
        <header class="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          <History class="size-3.5 shrink-0 text-brand" />
          <span class="shrink-0 text-foreground">
            Went back to #{props.entry.conversationId}/{data().at}
          </span>
          <span class="ml-auto shrink-0">
            {data().steps} step{data().steps === 1 ? '' : 's'} set aside
          </span>
        </header>
        <div class="flex min-w-0 flex-col gap-3 px-3 py-2.5 text-[13px] leading-relaxed">
          <Show when={data().summary}>
            {(summary) => (
              <div class="min-w-0" data-lineage-rewound-summary>
                <Markdown text={summary()} />
              </div>
            )}
          </Show>
          <Show when={data().summaryMissing}>
            <p class="text-[12px] text-muted-foreground">
              The summary model gave no summary; the files are listed.
            </p>
          </Show>
          <Show
            when={data().files.length > 0}
            fallback={
              <p class="text-[12.5px] text-muted-foreground">
                The worktree has no changes since then.
              </p>
            }
          >
            <div>
              <p class="mb-1 text-[12.5px] text-muted-foreground">
                Since then these files changed in the worktree. They&apos;re still there; decide
                whether to keep or undo them.
              </p>
              <Files files={data().files} />
            </div>
          </Show>
          <Show when={data().commits.length > 0}>
            <ul class="flex flex-col gap-0.5 font-mono text-[11.5px]">
              <For each={data().commits}>
                {(commit) => (
                  <li class="flex min-w-0 items-center gap-2">
                    <GitCommit class="size-3 shrink-0 text-muted-foreground" />
                    <span class="shrink-0 text-muted-foreground">{commit.sha.slice(0, 7)}</span>
                    <span class="min-w-0 truncate">{commit.subject}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={data().dependents.length > 0}>
            <div>
              <p class="mb-1 text-[12.5px] text-muted-foreground">
                Built on the set-aside path, still running on their own:
              </p>
              <Dependents dependents={data().dependents} />
            </div>
          </Show>
        </div>
      </Card>
    </Fold>
  )
})

export const RewoundDependent = renderEntry(RewoundDependentEntry, (props) => {
  const data = () => props.entry.data
  return (
    <Button
      aria-label={`Open #${data().from}, which went back to /${data().at} (marker #${props.entry.id})`}
      class="flex w-full min-w-0 items-center gap-3 rounded-none font-mono text-[11px] font-normal text-warning/90 before:h-px before:flex-1 before:bg-warning/30 after:h-px after:flex-1 after:bg-warning/30 hover:text-warning"
      data-lineage-rewound-dependent={data().from}
      onClick={() => switchConversation(data().from)}
      size={null}
      title={`#${data().from} went back to #${data().from}/${data().at} (note #${data().entry})`}
      variant={null}
    >
      <span class="flex max-w-[80%] min-w-0 items-center gap-1.5">
        <History class="size-3 shrink-0" />
        <span class="shrink-0">Built on a rewound path ·</span>
        <ConversationRef id={data().from} />
        <span class="shrink-0">went back to /{data().at}</span>
      </span>
    </Button>
  )
})
