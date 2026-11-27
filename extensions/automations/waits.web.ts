import type { AutomationListItem } from './refs.ts'

export function timerWaits(
  automations: readonly AutomationListItem[] | undefined,
  standing: Readonly<Record<string, number>> | null | undefined,
) {
  return (automations ?? [])
    .filter((a) => a.enabled)
    .map((a) => ({
      name: a.name,
      nextAt: a.nextAt,
      subscribers: a.subscribers.flatMap((subscriber) => {
        const id =
          typeof subscriber === 'number' ? subscriber : standing?.[subscriber.replace(/^@/, '')]
        return id === undefined ? [] : [id]
      }),
    }))
}
