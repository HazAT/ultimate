/** @jsxImportSource @solidjs/web */
import { createMemo, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { cn, openPanel, showSurface, switchConversation, useNow } from '@/sdk/solid'
import { active, attention, lookOf, looks, worstFirst } from './looks.ts'
import type { Look } from './looks.ts'
import { openAutomationsPanel } from './navigation.ts'
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
        <Button
          aria-label={`${state().count} active: show Automations panel`}
          class={cn(
            '-mx-1 h-auto gap-1.5 rounded-sm px-1 font-normal hover:bg-accent hover:text-foreground',
            attention(state().worst) && looks[state().worst].text,
          )}
          data-automations-chip={state().worst}
          onClick={() => openAutomationsPanel(shell)}
          size={null}
          title={state().breakdown.join(' · ')}
          variant={null}
        >
          <Dot look={state().worst} />
          {state().count} {state().count === 1 ? 'automation' : 'automations'}
        </Button>
      )}
    </Show>
  )
}
