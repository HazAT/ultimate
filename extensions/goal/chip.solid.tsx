/** @jsxImportSource @solidjs/web */
import { Flag } from '@lucide/solid'
import { Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { ROOT, api, showSurface, switchConversation, useDocOf, writingAs } from '@/sdk/solid'
import { StandingAction } from '../subagents/refs.ts'
import { GoalDoc } from './refs.ts'

export function useOpenGoal() {
  const doc = useDocOf(() => ROOT, GoalDoc)
  return () => doc()?.goals.find((goal) => !goal.ended)
}

export async function openUltimate(source: string) {
  try {
    const id = await writingAs(source, () => api.action(StandingAction, { name: 'ultimate' }))
    writingAs(source, () => {
      switchConversation(id)
      showSurface('agent')
    })
  } catch (error) {
    console.warn('Could not open @ultimate', error)
  }
}

export function HandsOff() {
  const goal = useOpenGoal()
  return (
    <Show when={goal()}>
      {(active) => (
        <Button
          aria-label={`Hands-off goal: ${active().text}`}
          class="-mx-1 flex items-center gap-1.5 rounded-sm px-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          data-goal-status
          onClick={(_, details) => openUltimate(details.source)}
          size={null}
          title={`Hands-off: ${active().text}`}
          variant={null}
        >
          <Flag aria-hidden="true" class="size-3 text-brand" />
          Hands-off
        </Button>
      )}
    </Show>
  )
}
