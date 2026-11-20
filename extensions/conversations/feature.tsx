import type { ConversationId } from '@earendil-works/pi-durable'
import { ROOT } from '@/sdk'
import { cn, useConversationSummary, useDocOf } from '@/sdk'
import { conversationRefParts, featureHue, featureTagClass } from '../../lib/conversation-ref.ts'
import { OverviewDoc } from './refs.ts'
import type { OverviewRow } from './types.ts'

const none: Record<string, OverviewRow> = {}

export function useOverview() {
  return useDocOf(ROOT, OverviewDoc)?.conversations ?? none
}

export function FeatureTag({ feature, className }: { feature: string; className?: string }) {
  return (
    <span
      className={cn(featureTagClass, featureHue(feature), className)}
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
  const { tag: nonStandingFeature, name } = conversationRefParts({
    standing: useStandingName(id),
    title,
    feature: useOverview()[id]?.feature,
    live: useConversationSummary(id)?.title,
  })
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
