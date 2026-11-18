import type { ConversationId } from '@earendil-works/pi-durable'
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
import {
  AllProvided,
  api,
  definePoint,
  Fold,
  Provided,
  useConversationSummary,
  useUltimate,
} from '@/sdk'
import { FeatureTag, useStandingName } from '../conversations/ui.tsx'
import { GithubAction, RepoAction } from './refs.ts'
import type { GithubRepo } from './refs.ts'
import type { ConversationSubject } from '../conversations/types.ts'

export function Open({
  id,
  className,
  label,
  entry,
}: {
  id: ConversationId
  className?: string
  label?: string
  entry?: number
}) {
  const { switchConversation } = useUltimate()
  const busy = useConversationSummary(id)?.busy
  return (
    <Button
      className={cn(
        'h-5 shrink-0 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground',
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

let githubRepoOncePerPage: Promise<string | null> | undefined
export function useGithubRepo() {
  const [url, setUrl] = useState<string | null>()
  useEffect(() => {
    githubRepoOncePerPage ??= api.action(GithubAction).catch(() => null)
    let live = true
    void githubRepoOncePerPage.then((value) => live && setUrl(value))
    return () => {
      live = false
    }
  }, [])
  return url
}

let projectRepoOncePerPage: Promise<GithubRepo | null> | undefined
export function useProjectRepo() {
  const [value, setValue] = useState<GithubRepo | null>()
  useEffect(() => {
    projectRepoOncePerPage ??= api.action(RepoAction).catch(() => null)
    let live = true
    void projectRepoOncePerPage.then((found) => live && setValue(found))
    return () => {
      live = false
    }
  }, [])
  return value
}

export const Review = definePoint<string, (() => void) | undefined>('workspaces.review')

export const LandedNote = definePoint<
  { conversation: ConversationId; submission: string },
  ReactNode | undefined
>('workspaces.landed-note')

export const LandingExtras = definePoint<ConversationId, ReactNode>('workspaces.landing-extras')

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

function useStandingOrSubmittedSubject(from: ConversationId, subject?: ConversationSubject) {
  const agent = useStandingName(from)
  return agent ? { title: agent } : subject
}

export function Subject({
  subject: given,
  from,
  className,
}: {
  subject?: ConversationSubject
  from: ConversationId
  className?: string
}) {
  const { switchConversation } = useUltimate()
  const subject = useStandingOrSubmittedSubject(from, given)
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      {subject?.feature && <FeatureTag className="shrink-0" feature={subject.feature} />}
      <button
        className="min-w-0 cursor-pointer truncate font-sans text-[12.5px] text-foreground hover:underline"
        onClick={() => switchConversation(from)}
        title={`Open #${from}`}
        type="button"
      >
        {subject?.title ?? `#${from}`}
      </button>
      {subject?.title && <span className="shrink-0 text-muted-foreground/70">#{from}</span>}
    </span>
  )
}

export type LandingTone = 'landed' | 'pushFailed' | 'failed'
const tones = {
  landed: ['border-l-success/70', 'text-success', CheckIcon, 'landed'],
  pushFailed: ['border-l-warning/70', 'text-warning', TriangleAlertIcon, 'push failed'],
  failed: ['border-l-error/70', 'text-error', XIcon, 'not landed'],
} as const

export function LandingCard({
  card: foldStateEntry,
  tone,
  headline,
  subject,
  from,
  sha,
  at,
  divergence,
  sourceEntry,
  submission,
  children,
}: {
  card: number
  tone: LandingTone
  headline: ReactNode
  subject?: ConversationSubject
  from: ConversationId
  sha?: string
  at?: ReactNode
  divergence?: string
  sourceEntry?: number
  submission?: string
  children?: ReactNode
}) {
  const [border, color, Icon, label] = tones[tone]
  const named = useStandingOrSubmittedSubject(from, subject)
  return (
    <Fold
      card={foldStateEntry}
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
          'min-w-0 rounded-md border border-l-2 border-border bg-muted/20 font-mono text-[12px]',
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
            <p className="pl-5.5 font-sans text-[12.5px] leading-relaxed text-muted-foreground">
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
              <span className="shrink-0 text-[11px]">Diverged</span>
              <span className="min-w-0 font-sans text-[12.5px] break-words">
                <MentionText text={divergence} />
              </span>
            </p>
          )}
          {children}
          {submission && tone !== 'failed' && (
            <Provided input={{ conversation: from, submission }} point={LandedNote}>
              {(note) => note}
            </Provided>
          )}
          {tone !== 'failed' && (
            <AllProvided input={from} point={LandingExtras}>
              {(extras) => extras}
            </AllProvided>
          )}
        </div>
      </section>
    </Fold>
  )
}
