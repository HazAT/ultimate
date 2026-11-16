import { cn, useNow, useUltimate } from '@/sdk'
import {
  Dot,
  active,
  attention,
  lookOf,
  looks,
  openAutomationsPanel,
  useAutomations,
  worstFirst,
} from './parts.tsx'

export function Chip() {
  const shell = useUltimate()
  const { data } = useAutomations(5000)
  const now = useNow(15_000)
  const list = worstFirst(
    (data ?? []).filter((automation) => active(automation, now)),
    now,
  )
  const [first] = list
  if (!first) return null
  const worst = lookOf(first, now)
  const counts = [...new Set(list.map((automation) => lookOf(automation, now)))].map(
    (look) =>
      `${list.filter((automation) => lookOf(automation, now) === look).length} ${looks[look].word}`,
  )
  return (
    <button
      aria-label={`${list.length} automations: ${counts.join(', ')}`}
      className={cn(
        '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground',
        attention(worst) && looks[worst].text,
      )}
      data-automations-chip={worst}
      onClick={() => openAutomationsPanel(shell)}
      title={counts.join(' · ')}
      type="button"
    >
      <Dot look={worst} />
      {list.length} {list.length === 1 ? 'automation' : 'automations'}
    </button>
  )
}
