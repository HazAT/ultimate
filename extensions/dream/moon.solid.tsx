import { cn } from '@/sdk/solid'
import type { PassName } from './types.shared.ts'

export const passLabels: Record<PassName, string> = {
  memory: 'Memory',
  failures: 'Failures',
  tools: 'Tools',
  corrections: 'Corrections & wishes',
  codify: 'Codify memories',
  project: 'This project',
}

const WAXING_CRESCENT_RIGHT_RIM = 'M6 1 A5 5 0 0 1 6 11 A2.4 5 0 0 0 6 1 Z'
export function Moon(props: { status: 'waiting' | 'running' | 'done' | 'failed'; class?: string }) {
  return (
    <svg
      aria-hidden="true"
      class={cn(
        'size-3 shrink-0',
        props.status === 'failed' ? 'text-error/70' : 'text-brand',
        props.status === 'waiting' && 'text-muted-foreground/50',
        props.class,
      )}
      viewBox="0 0 12 12"
    >
      <circle
        cx="6"
        cy="6"
        fill={props.status === 'done' ? 'currentColor' : 'none'}
        r="5"
        stroke="currentColor"
        stroke-opacity={props.status === 'done' ? 1 : 0.6}
        stroke-width="1"
      />
      {props.status === 'running' && (
        <path
          class="motion-safe:animate-pulse-dot"
          d={WAXING_CRESCENT_RIGHT_RIM}
          fill="currentColor"
          style={{ 'animation-duration': '2.8s' }}
        />
      )}
      {props.status === 'failed' && (
        <circle cx="6" cy="6" fill="currentColor" opacity="0.25" r="5" />
      )}
    </svg>
  )
}
