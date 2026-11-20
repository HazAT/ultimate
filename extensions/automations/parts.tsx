import { cn, api, useUltimate } from '@/sdk'
import { dotStatus, looks } from './looks.ts'
import type { Look } from './looks.ts'
import { openAutomation } from './navigation.ts'

export function Dot({ look, className }: { look: Look; className?: string }) {
  const { dot, word, busy } = looks[look]
  return (
    <span
      aria-label={word}
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        dot,
        busy && 'animate-pulse-dot',
        className,
      )}
      data-status={dotStatus(look)}
      role="img"
    />
  )
}

export function useOpenAutomation() {
  const shell = useUltimate()
  return (id: string) => openAutomation(id, shell, api.action)
}
