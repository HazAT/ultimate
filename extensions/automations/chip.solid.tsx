import { createMemo, Show } from 'solid-js'
import { StatusButton } from '@/components/ui/status-trigger.solid.tsx'
import { cn, openPanel, showSurface, switchConversation, useNow } from '@/sdk/solid'
import { active, attention, lookOf, looks, worstFirst } from './looks.web.ts'
import type { Look } from './looks.web.ts'
import { openAutomationsPanel } from './navigation.web.ts'
import { Dot } from './parts.solid.tsx'
import { useAutomations } from './live.solid.tsx'

const shell = { openPanel, showSurface, switchConversation }

export function Chip() {
  const list = useAutomations(() => 5000)
  const now = useNow(15_000)
  const summary = createMemo(() => {
    const at = now()
    const running = worstFirst(
      (list().data ?? []).filter((item) => active(item, at)),
      at,
    )
    if (!running.length) return undefined
    const counts = new Map<Look, number>()
    for (const item of running) {
      const look = lookOf(item, at)
      counts.set(look, (counts.get(look) ?? 0) + 1)
    }
    return {
      count: running.length,
      worst: lookOf(running[0], at),
      breakdown: [...counts].map(([look, count]) => `${count} ${looks[look].word}`),
    }
  })
  return (
    <Show when={summary()}>
      {(state) => (
        <StatusButton
          aria-label={`${state().count} active: show Automations panel`}
          class={cn(attention(state().worst) && looks[state().worst].text)}
          data-automations-chip={state().worst}
          onClick={() => openAutomationsPanel(shell)}
          title={state().breakdown.join(' · ')}
        >
          <Dot look={state().worst} />
          {state().count} {state().count === 1 ? 'automation' : 'automations'}
        </StatusButton>
      )}
    </Show>
  )
}
