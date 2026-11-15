import { cn } from '@/sdk'
import type { PassName } from './types.ts'

export const passLabels: Record<PassName, string> = {
  memory: 'Memory',
  failures: 'Failures',
  tools: 'Tools',
  corrections: 'Corrections & wishes',
  codify: 'Codify memories',
  project: 'This project',
}

const WAXING_CRESCENT_RIGHT_RIM = 'M6 1 A5 5 0 0 1 6 11 A2.4 5 0 0 0 6 1 Z'
export function Moon({
  status,
  className,
}: {
  status: 'waiting' | 'running' | 'done' | 'failed'
  className?: string
}) {
  return (
    <svg
      aria-hidden
      className={cn(
        'size-3 shrink-0',
        status === 'failed' ? 'text-error/70' : 'text-brand',
        status === 'waiting' && 'text-muted-foreground/50',
        className,
      )}
      viewBox="0 0 12 12"
    >
      <circle
        cx="6"
        cy="6"
        fill={status === 'done' ? 'currentColor' : 'none'}
        r="5"
        stroke="currentColor"
        strokeOpacity={status === 'done' ? 1 : 0.6}
        strokeWidth="1"
      />
      {status === 'running' && (
        <path
          className="motion-safe:animate-pulse-dot"
          d={WAXING_CRESCENT_RIGHT_RIM}
          fill="currentColor"
          style={{ animationDuration: '2.8s' }}
        />
      )}
      {status === 'failed' && <circle cx="6" cy="6" fill="currentColor" opacity="0.25" r="5" />}
    </svg>
  )
}
