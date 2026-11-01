import { cn } from 'cn'
import {
  ArrowUpRightIcon,
  CheckIcon,
  SquareArrowOutUpRightIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { MentionText } from '@/components/ai/message'
import { Button } from '@/components/ui/button'
import { api, definePoint, Fold, Provided, useConversations, useUltimate } from '@/sdk'
import { FeatureTag, useStandingName } from '../conversations/ui.tsx'
import { GithubAction } from './refs.ts'
import type { ConversationSubject } from '../conversations/types.ts'

/** "open #id", with a dot while that conversation works. */
export function Open({
  id,
  className,
  label,
  entry,
}: {
  id: number
  className?: string
  label?: string
  entry?: number
}) {
  const { switchConversation } = useUltimate()
  const busy = useConversations().find((conversation) => conversation.id === id)?.busy
  return (
    <Button
      className={cn(
        'h-5 shrink-0 gap-1 px-1.5 font-mono text-[0.6875rem] text-muted-foreground hover:text-foreground',
        className,
      )}
      onClick={() => switchConversation(id)}
      size="xs"
      title={`Show conversation #${id}`}
      variant="ghost"
    >
      {busy && <span className="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand" />}
      <SquareArrowOutUpRightIcon className="size-3" />
      open {label ? `${label} ` : ''}#{id}
      {entry !== undefined ? `/${entry}` : ''}
    </Button>
  )
}

let repo: Promise<string | null> | undefined
/** The project's `github.com/<owner>/<repo>`, or null off GitHub; asked once per page. */
export function useGithubRepo() {
  const [url, setUrl] = useState<string | null>()
  useEffect(() => {
    repo ??= api.action(GithubAction).catch(
      // No repository: landings show their count without a link.
      () => null,
    )
    let live = true
    // oxlint-disable-next-line typescript/no-floating-promises -- repo converts action failures to null; the callback only updates state.
    void repo.then((value) => live && setUrl(value))
    return () => {
      live = false
    }
  }, [])
  return url
}

/**
 * Opens a review of a spec (`<base>...<sha>`, `branch:<name>`) in the app, or undefined while nothing reviews
 * (`review` provides it).
 */
export const Review = definePoint<string, (() => void) | undefined>('workspaces.review')

const external = (href: string, children: ReactNode, className?: string) => (
  <a
    className={cn(
      'inline-flex shrink-0 items-center gap-0.5 hover:text-foreground hover:underline',
      className,
    )}
    href={href}
    rel="noreferrer"
    target="_blank"
    title={`Compare on DiffsHub: ${href.replace(/^https:\/\/diffshub\.com\//, '')}`}
  >
    {children}
    <ArrowUpRightIcon className="size-2.5 opacity-60" />
  </a>
)

/**
 * "3 commits": opens a review of `range` (`<base>...<sha>`) while something reviews, with the DiffsHub compare `href`
 * as a small ↗ beside it; otherwise the count links to DiffsHub itself.
 */
export function CommitCount({
  count,
  href,
  range,
  className,
}: {
  count: number
  href?: string
  range?: string
  className?: string
}) {
  const label = `${count} commit${count === 1 ? '' : 's'}`
  const plain = href ? (
    external(href, label, className)
  ) : (
    <span className={cn('shrink-0', className)}>{label}</span>
  )
  if (!range) return plain
  return (
    <Provided input={range} point={Review}>
      {(open) =>
        open ? (
          <span className={cn('inline-flex shrink-0 items-center gap-1', className)}>
            <button
              className="cursor-pointer hover:text-foreground hover:underline"
              onClick={open}
              title={`Review ${range.replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/g, '$1')}`}
              type="button"
            >
              {label}
            </button>
            {href && external(href, null)}
          </span>
        ) : (
          plain
        )
      }
    </Provided>
  )
}

/**
 * What a submission lands as the feature its conversation had at submit time; a standing agent is only ever its
 * `@name`, whatever branch work it last submitted.
 */
function useSubject(from: number, subject?: ConversationSubject) {
  const agent = useStandingName(from)
  return agent ? { title: agent } : subject
}

/** The feature a submission lands, as one line: its feature tag and title, then `#id`. */
export function Subject({
  subject: given,
  from,
  className,
}: {
  subject?: ConversationSubject
  from: number
  className?: string
}) {
  const { switchConversation } = useUltimate()
  const subject = useSubject(from, given)
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      {subject?.feature && <FeatureTag className="shrink-0" feature={subject.feature} />}
      <button
        className="min-w-0 cursor-pointer truncate font-sans text-[0.7812rem] text-foreground hover:underline"
        onClick={() => switchConversation(from)}
        title={`Open #${from}`}
        type="button"
      >
        {subject?.title ?? `#${from}`}
      </button>
      {subject?.title && <span className="shrink-0 text-muted-foreground">#{from}</span>}
    </span>
  )
}

export type LandingTone = 'landed' | 'pushFailed' | 'failed'
const tones = {
  landed: ['border-l-success/70', 'text-success', CheckIcon, 'landed'],
  pushFailed: ['border-l-warning/70', 'text-warning', TriangleAlertIcon, 'push failed'],
  failed: ['border-l-error/70', 'text-error', XIcon, 'not landed'],
} as const

/**
 * A landing as one card: the feature it lands (tag, title, summary) from its conversation's summary at submit time,
 * the outcome's headline, then `children` (commits, flaky checks, steps). The lander's log, the submitter's report and
 * the root's note all show it. In a chat it folds to one line: the outcome, the feature, `sha`.
 */
export function LandingCard({
  card,
  tone,
  headline,
  subject,
  from,
  sha,
  at,
  divergence,
  sourceEntry,
  children,
}: {
  /** The entry that shows it, which keeps its fold state. */
  card: number
  tone: LandingTone
  headline: ReactNode
  subject?: ConversationSubject
  /** The submitting conversation. */
  from: number
  /** The landed commit, for the folded line. */
  sha?: string
  at?: ReactNode
  divergence?: string
  sourceEntry?: number
  children?: ReactNode
}) {
  const [border, color, Icon, label] = tones[tone]
  const named = useSubject(from, subject)
  return (
    <Fold
      card={card}
      summary={
        <>
          <Icon className={cn('size-3 shrink-0', color)} />
          <span className={cn('shrink-0', color)}>{label}</span>
          {named?.feature && <FeatureTag className="shrink-0" feature={named.feature} />}
          <span className="min-w-0 truncate text-foreground/80">{named?.title ?? `#${from}`}</span>
          {named?.title && <span className="shrink-0">#{from}</span>}
          {sha && <span className="shrink-0">· {sha.slice(0, 7)}</span>}
        </>
      }
    >
      <section
        className={cn(
          'min-w-0 rounded-md border border-l-2 border-border bg-muted/20 font-mono text-[0.75rem]',
          border,
        )}
        data-landing={tone}
      >
        <header className="space-y-1 border-b border-border/60 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Icon className={cn('size-3.5 shrink-0', color)} />
            <Subject className="flex-1" from={from} subject={subject} />
            {sourceEntry !== undefined && <Open id={from} entry={sourceEntry} />}
          </div>
          {subject?.summary && (
            <p className="pl-5.5 font-sans text-[0.7812rem] leading-relaxed text-muted-foreground">
              {subject.summary}
            </p>
          )}
        </header>
        <div className="space-y-1.5 px-3 py-2.5 pl-8.5">
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1 break-words text-foreground/90">{headline}</span>
            {at}
          </div>
          {divergence && (
            <p className="flex items-baseline gap-2 text-muted-foreground">
              <span className="shrink-0 text-[0.6875rem]">Diverged</span>
              <span className="min-w-0 font-sans text-[0.7812rem] break-words">
                <MentionText text={divergence} />
              </span>
            </p>
          )}
          {children}
        </div>
      </section>
    </Fold>
  )
}
