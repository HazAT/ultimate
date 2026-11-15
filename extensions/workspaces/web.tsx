import type { EntryRecord, ConversationId } from '@earendil-works/pi-durable'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowUpRightIcon, ChevronRightIcon, GitMergeIcon } from 'lucide-react'
import { MentionText } from '@/components/ai/message'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  api,
  cn,
  column,
  ConversationTitle,
  ConversationTitleAside,
  defineWebExtension,
  provide,
  useConversation,
  useConversationSummary,
  useTranscript,
} from '@/sdk'
import { useWorkspaceIndex } from './data.tsx'
import { PullRequestAction } from './refs.ts'
import type { PullRequest } from './refs.ts'
import { CommitCount, LandingCard, useGithubRepo } from './landing.tsx'
import { LanderLogEntry, LanderReport, WorkspaceCall } from './log.tsx'
import { compareUrl } from '../../lib/compare.ts'

/** The lander's note in the root: the landing's card, from the note's own data, with the state it froze. */
function LandingNote({ entry }: { entry: EntryRecord }) {
  const {
    from,
    at,
    divergence,
    sha,
    base,
    target,
    title,
    summary,
    feature,
    commits,
    paths,
    more,
    pushed,
    abstract,
  } = entry.data as {
    from: ConversationId
    at?: number
    divergence?: string
    sha: string
    base?: string
    target: string
    title?: string
    summary?: string
    feature?: string
    commits: { sha: string; subject: string }[]
    paths: string[]
    more: number
    pushed?: string
    abstract?: { at: number; text: string }
  }
  const github = useGithubRepo()
  // A note from before landings recorded their base: the landing before it, where the lander's serial queue left the
  // target.
  const transcript = useTranscript()
  const previous = base
    ? undefined
    : (
        transcript.findLast(
          (other) =>
            other.kind === 'lineage.note' &&
            other.id < entry.id &&
            (other.data as { source?: string })?.source === 'lander',
        )?.data as { sha?: string } | undefined
      )?.sha
  const rangeBase = base ?? previous
  return (
    <div data-lineage-note="lander">
      <LandingCard
        card={entry.id}
        sha={sha}
        from={from}
        sourceEntry={at}
        divergence={divergence}
        headline={
          <span className="flex flex-wrap items-center gap-x-2">
            <span>
              Landed {sha.slice(0, 7)} on {target}
              {pushed ? ` · pushed to ${pushed}` : ''}
            </span>
            <CommitCount
              className="text-muted-foreground"
              count={commits.length + more}
              href={github && rangeBase ? compareUrl(github, rangeBase, sha) : undefined}
              range={rangeBase ? `${rangeBase}...${sha}` : undefined}
            />
          </span>
        }
        subject={{
          ...(title ? { title } : {}),
          ...(summary ? { summary } : {}),
          ...(feature ? { feature } : {}),
        }}
        tone="landed"
      >
        {paths.length > 0 && (
          <p className="break-words text-muted-foreground">Changed: {paths.join(', ')}</p>
        )}
        {abstract && (
          <Collapsible className="group/state">
            <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
              <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/state:rotate-90" />
              State at landing
              <span className="text-muted-foreground/70">
                · #{from}/{abstract.at}
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-1 pl-4 font-sans text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
              <MentionText text={abstract.text} />
            </CollapsibleContent>
          </Collapsible>
        )}
      </LandingCard>
    </div>
  )
}

/** The lander's conversation is its log: in place of a composer, a line saying what it is. */
function LanderComposer({ core, dock }: { core: ReactNode; dock?: boolean }) {
  const id = useConversation((conversation) => conversation.id)
  const landers = Object.values(useWorkspaceIndex().landerConversations)
  if (id === undefined || !landers.includes(id)) return core
  return (
    <div className={cn(column(dock), 'pb-3')}>
      <div
        className="flex items-center gap-2.5 rounded-lg border border-border/70 bg-muted/30 px-3.5 py-2.5 text-[12.5px] text-muted-foreground"
        data-lander-log={id}
      >
        <GitMergeIcon className="size-4 shrink-0 text-brand" />
        The landing log. The lander is code, not a model: each submission's outcome goes back to its
        branch.
      </div>
    </div>
  )
}

/** `PR #12` or `pull request #12`; a bare `#12` may be an issue or a conversation, so it stays text. */
const pullRequest = /\b(?:PR|pull request) #(\d+)\b/gi

/** A title with its pull request references linked to the project's GitHub, or undefined when none link. */
function useLinkedTitle(title: string) {
  const github = useGithubRepo()
  if (!github || !title.match(pullRequest)) return undefined
  const parts: ReactNode[] = []
  let last = 0
  for (const match of title.matchAll(pullRequest)) {
    parts.push(title.slice(last, match.index))
    parts.push(
      <a
        className="hover:underline"
        href={`https://${github}/pull/${match[1]}`}
        key={match.index}
        rel="noreferrer"
        target="_blank"
      >
        {match[0]}
      </a>,
    )
    last = match.index + match[0].length
  }
  parts.push(title.slice(last))
  return parts
}

const pullStates: Record<PullRequest['state'], string> = {
  open: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
  merged: 'bg-violet-500/12 text-violet-700 dark:text-violet-300',
  closed: 'bg-muted/60 text-muted-foreground',
}

/** `PR #12 ↗` after the title while conversation `id`'s branch has a pull request, coloured by its state. */
function usePullRequestChip(id: ConversationId) {
  const [pull, setPull] = useState<PullRequest | null>()
  // Asked again when the conversation's work moves on: its summary's activity changes with each turn.
  const at = useConversationSummary(id)?.inputAt
  useEffect(() => {
    let live = true
    void api
      .action(PullRequestAction, { id })
      .catch(
        // No worktree or GitHub unreachable: no chip.
        () => null,
      )
      .then((value) => live && setPull(value))
    return () => {
      live = false
    }
  }, [id, at])
  if (!pull) return undefined
  return (
    <a
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-sm px-1.5 font-mono text-[11px] leading-5 transition-opacity hover:opacity-80',
        pullStates[pull.state],
      )}
      href={pull.url}
      rel="noreferrer"
      target="_blank"
      title={`Pull request #${pull.number} (${pull.state}) on GitHub`}
    >
      PR #{pull.number}
      <ArrowUpRightIcon className="size-3 opacity-70" />
    </a>
  )
}

export default defineWebExtension({
  composer: LanderComposer,
  provides: [
    provide(ConversationTitle, useLinkedTitle),
    provide(ConversationTitleAside, usePullRequestChip),
  ],
  tools: { workspace: WorkspaceCall },
  entries: {
    'lineage.note': ({ entry, core }) =>
      (entry.data as { source?: string })?.source === 'lander' ? (
        <LandingNote entry={entry} />
      ) : (
        core
      ),
    'ultimate.lander': LanderLogEntry,
    'workspaces.lander-report': LanderReport,
  },
})
