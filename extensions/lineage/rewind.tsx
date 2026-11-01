/**
 * Going back to an entry in the browser: the "Go back to here" message action and its confirm dialog, the note card
 * the go-back leaves, and the marker on conversations that built on the set-aside path.
 */
import { FileIcon, GitCommitIcon, GitForkIcon, HistoryIcon } from 'lucide-react'
import { useState } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { api, Card, errorMessage, Fold, useAction, useConversation, useUltimate } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { ConversationRef } from '../conversations/ui.tsx'
import { RewindAction, RewindPreviewAction } from './refs.ts'
import type { RewindDependent, RewindFile } from './refs.ts'
import { useRoots } from './ui.tsx'

const via = { subagent: 'subagent', branch: 'branch', message: 'messaged' } as const

/** Changed files with their line counts, as a landing card lists them. */
function Files({ files }: { files: readonly RewindFile[] }) {
  return (
    <ul className="flex flex-col gap-0.5 font-mono text-[0.7188rem]">
      {files.map((file) => (
        <li className="flex min-w-0 items-center gap-2" key={file.path}>
          <FileIcon className="size-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate" title={file.path}>
            {file.path}
          </span>
          <span className="ml-auto shrink-0 tabular-nums">
            {file.outside ? (
              <span className="text-muted-foreground">outside the checkout</span>
            ) : file.untracked ? (
              <span className="text-muted-foreground">new</span>
            ) : file.added === undefined ? (
              <span className="text-muted-foreground">changed</span>
            ) : (
              <>
                <span className="text-success">+{file.added}</span>{' '}
                <span className="text-error">−{file.removed ?? 0}</span>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

function Dependents({ dependents }: { dependents: readonly RewindDependent[] }) {
  return (
    <ul className="flex flex-col gap-0.5 font-mono text-[0.7188rem]">
      {dependents.map((dependent) => (
        <li className="flex min-w-0 items-center gap-2" key={dependent.id}>
          <GitForkIcon className="size-3 shrink-0 text-muted-foreground" />
          <ConversationRef id={dependent.id} />
          <span className="ml-auto shrink-0 text-muted-foreground">{via[dependent.via]}</span>
        </li>
      ))}
    </ul>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <p className="mb-1.5 section-label">{title}</p>
      {children}
    </div>
  )
}

/** Confirms going back to `entry`: what it sets aside, what stays in the checkout, who built on it. */
function GoBackDialog({ entry, onClose }: { entry: EntryRecord; onClose: () => void }) {
  const { conversationId: conversation, id: at } = entry
  const preview = useAction(RewindPreviewAction, { conversation, at })
  const [summarize, setSummarize] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const result = preview.data
  const refused = result?.refused
  const go = async () => {
    setPending(true)
    setError(undefined)
    try {
      await api.action(RewindAction, { conversation, at, summarize })
      onClose()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md" showCloseButton={false}>
        <div className="max-h-[70vh] overflow-y-auto px-5 pt-5 pb-4" data-lineage-rewind-dialog>
          <DialogTitle className="text-[0.875rem] font-medium">
            Go back to #{conversation}/{at}?
          </DialogTitle>
          <DialogDescription className="mt-2 text-[0.8125rem] leading-relaxed break-words">
            {refused ? (
              <span className="text-error" data-lineage-rewind-refused>
                {refused}
              </span>
            ) : (
              <>
                What came after this point leaves the context and stays readable, folded. Files and
                commits stay as they are; the next message you send continues from here.
              </>
            )}
          </DialogDescription>
          {!result && !preview.error && (
            <p className="mt-4 font-mono text-[0.6875rem] text-muted-foreground">
              Reading what changed…
            </p>
          )}
          {result && !refused && (
            <>
              <p className="mt-3 font-mono text-[0.6875rem] text-muted-foreground">
                {result.steps} step{result.steps === 1 ? '' : 's'} set aside
                {result.commits.length
                  ? ` · ${result.commits.length} commit${result.commits.length === 1 ? '' : 's'} since`
                  : ''}
              </p>
              <Section title="Files changed since (kept in the worktree)">
                {result.files.length ? (
                  <Files files={result.files} />
                ) : (
                  <p className="text-[0.7812rem] text-muted-foreground">No changes.</p>
                )}
              </Section>
              {result.dependents.length > 0 && (
                <Section title="Built on this path">
                  <Dependents dependents={result.dependents} />
                  <p className="mt-1.5 text-[0.75rem] text-muted-foreground">
                    They keep running on their own and get a marker.
                  </p>
                </Section>
              )}
              <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-[0.8125rem]">
                <Checkbox
                  checked={summarize}
                  className="mt-0.5"
                  disabled={!result.summaryModel}
                  onCheckedChange={(value) => setSummarize(value === true)}
                />
                <span>
                  Summarize what came after this point
                  <span className="block text-[0.75rem] text-muted-foreground">
                    {result.summaryModel
                      ? 'The summary model adds decisions, results and open threads to the note.'
                      : 'No summary model is available; the note lists the files.'}
                  </span>
                </span>
              </label>
            </>
          )}
          {error && <p className="mt-3 font-mono text-[0.75rem] break-words text-error">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-border/70 bg-sidebar px-5 py-3">
          <Button onClick={onClose} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button disabled={pending || !result || !!refused} onClick={() => void go()} size="sm">
            {pending ? (summarize ? 'Summarizing…' : 'Going back…') : 'Go back'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** The hover action on a stored message of any conversation but a root. */
export function GoBackAction({ entry }: { entry: EntryRecord }) {
  const roots = useRoots()
  const shown = useConversation((conversation) => conversation.id)
  const [open, setOpen] = useState(false)
  if (!roots || roots.includes(entry.conversationId) || shown !== entry.conversationId) return null
  return (
    <>
      <button
        aria-label="Go back to here"
        className="cursor-pointer rounded p-0.5 transition-colors hover:text-foreground [&_svg]:size-3"
        data-lineage-go-back={entry.id}
        onClick={() => setOpen(true)}
        title="Go back to here"
        type="button"
      >
        <HistoryIcon />
      </button>
      {open && <GoBackDialog entry={entry} onClose={() => setOpen(false)} />}
    </>
  )
}

type RewoundData = {
  at: number
  steps: number
  files: RewindFile[]
  commits: { sha: string; subject: string }[]
  dependents: RewindDependent[]
  summary?: string
  summaryMissing?: true
}

/** The note a go-back left: where it went back to, the summary when asked for, the files and who built on the path. */
export function Rewound({ entry }: { entry: EntryRecord }) {
  const { at, steps, files, commits, dependents, summary, summaryMissing } =
    entry.data as RewoundData
  return (
    <Fold
      card={entry.id}
      summary={
        <>
          <HistoryIcon className="size-3 shrink-0 text-brand" />
          <span className="shrink-0">
            Went back to #{entry.conversationId}/{at} · {files.length} file
            {files.length === 1 ? '' : 's'} changed
          </span>
        </>
      }
    >
      <Card data-lineage-rewound={at}>
        <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[0.6875rem] text-muted-foreground">
          <HistoryIcon className="size-3.5 shrink-0 text-brand" />
          <span className="shrink-0 text-foreground">
            Went back to #{entry.conversationId}/{at}
          </span>
          <span className="ml-auto shrink-0">
            {steps} step{steps === 1 ? '' : 's'} set aside
          </span>
        </header>
        <div className="flex min-w-0 flex-col gap-3 px-3 py-2.5 text-[0.8125rem] leading-relaxed">
          {summary && (
            <div className="min-w-0" data-lineage-rewound-summary>
              <MessageResponse>{summary}</MessageResponse>
            </div>
          )}
          {summaryMissing && (
            <p className="text-[0.75rem] text-muted-foreground">
              The summary model gave no summary; the files are listed.
            </p>
          )}
          {files.length ? (
            <div>
              <p className="mb-1 text-[0.7812rem] text-muted-foreground">
                Since then these files changed in the worktree. They&apos;re still there; decide
                whether to keep or undo them.
              </p>
              <Files files={files} />
            </div>
          ) : (
            <p className="text-[0.7812rem] text-muted-foreground">
              The worktree has no changes since then.
            </p>
          )}
          {commits.length > 0 && (
            <ul className="flex flex-col gap-0.5 font-mono text-[0.7188rem]">
              {commits.map((commit) => (
                <li className="flex min-w-0 items-center gap-2" key={commit.sha}>
                  <GitCommitIcon className="size-3 shrink-0 text-muted-foreground" />
                  <span className="shrink-0 text-muted-foreground">{commit.sha.slice(0, 7)}</span>
                  <span className="min-w-0 truncate">{commit.subject}</span>
                </li>
              ))}
            </ul>
          )}
          {dependents.length > 0 && (
            <div>
              <p className="mb-1 text-[0.7812rem] text-muted-foreground">
                Built on the set-aside path, still running on their own:
              </p>
              <Dependents dependents={dependents} />
            </div>
          )}
        </div>
      </Card>
    </Fold>
  )
}

/** In a conversation that built on a path its source later set aside: a quiet divider that opens the go-back. */
export function RewoundDependent({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  const { from, at, entry: note } = entry.data as { from: number; at: number; entry: number }
  return (
    <button
      className="flex w-full min-w-0 cursor-pointer items-center gap-3 font-mono text-[0.6875rem] text-warning/90 before:h-px before:flex-1 before:bg-warning/30 after:h-px after:flex-1 after:bg-warning/30 hover:text-warning"
      data-lineage-rewound-dependent={from}
      onClick={() => switchConversation(from)}
      title={`#${from} went back to #${from}/${at} (note #${note})`}
      type="button"
    >
      <span className="flex max-w-[80%] min-w-0 items-center gap-1.5">
        <HistoryIcon className="size-3 shrink-0" />
        <span className="shrink-0">Built on a rewound path ·</span>
        <ConversationRef id={from} />
        <span className="shrink-0">went back to /{at}</span>
      </span>
    </button>
  )
}
