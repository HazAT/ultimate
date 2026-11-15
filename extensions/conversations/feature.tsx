import type { ConversationId } from '@earendil-works/pi-durable'
import { ROOT } from '@/sdk'
import { cn, useConversationSummary, useDocOf } from '@/sdk'
import { OverviewDoc } from './refs.ts'
import type { OverviewRow } from './types.ts'

const none: Record<string, OverviewRow> = {}

export function useOverview() {
  return useDocOf(ROOT, OverviewDoc)?.conversations ?? none
}

const hues = [
  'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  'bg-teal-500/15 text-teal-700 dark:text-teal-300',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
]

export function FeatureTag({ feature, className }: { feature: string; className?: string }) {
  let hash = 0
  for (const char of feature) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) | 0
  return (
    <span
      className={cn(
        'min-w-0 truncate rounded px-1.5 font-sans text-[10px] leading-4',
        hues[(hash >>> 0) % hues.length],
        className,
      )}
      data-feature={feature}
      title={feature}
    >
      {feature}
    </span>
  )
}

export function useStandingName(id: ConversationId | undefined) {
  const live = useConversationSummary(id)
  return live?.label === 'agent' ? live.title : undefined
}

export function ConversationRef({
  id,
  title,
  className,
}: {
  id: ConversationId
  title?: string
  className?: string
}) {
  const overview = useOverview()
  const live = useConversationSummary(id)?.title
  const agent = useStandingName(id)
  const nonStandingFeature = agent ? undefined : overview[id]?.feature
  const name = agent ?? title ?? (nonStandingFeature ? undefined : live)
  return (
    <span
      className={cn('inline-flex max-w-full min-w-0 items-center gap-1.5', className)}
      data-conversation-ref={id}
    >
      {nonStandingFeature && <FeatureTag className="shrink-0" feature={nonStandingFeature} />}
      {name && (
        <span className="min-w-0 truncate" title={name}>
          {name}
        </span>
      )}
      <span className="shrink-0 text-muted-foreground/70">#{id}</span>
    </span>
  )
}
