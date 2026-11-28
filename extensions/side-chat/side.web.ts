import type { ConversationId } from '@earendil-works/pi-durable'
import type { SideChatEndReason, SideChatSourceSession } from './refs.ts'

export interface TabKey {
  key: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  isComposing: boolean
}

export function togglesSideMode(
  event: TabKey,
  where: { conversation?: ConversationId; ultimate?: number; popup: boolean },
) {
  return (
    event.key === 'Tab' &&
    !event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.isComposing &&
    !where.popup &&
    where.conversation !== undefined &&
    where.conversation === where.ultimate
  )
}

export function sourceName(
  source: number,
  standing: Readonly<Record<string, number>> | null | undefined,
  title: string | undefined,
) {
  const name = Object.keys(standing ?? {}).find((key) => standing?.[key] === source)
  if (name) return `@${name}`
  return title?.trim() ? `#${source} ${title.trim()}` : `#${source}`
}

const reasons = {
  quiet: (minutes: number) => `ended after ${minutes} min quiet`,
  fresh: () => 'started fresh',
  answered: () => 'answered the card',
  handoff: () => 'handed off',
}

export function closingReason(reason: SideChatEndReason, minutes: number) {
  return reasons[reason](minutes)
}

export function closing(last: NonNullable<SideChatSourceSession['last']>, minutes: number) {
  return {
    reason: closingReason(last.reason, minutes),
    handback:
      last.reason === 'handoff'
        ? 'brief sent'
        : last.summary
          ? 'summary sent'
          : last.failed
            ? 'summary failed'
            : 'nothing to hand back',
  }
}
