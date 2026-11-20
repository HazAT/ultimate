/** @jsxImportSource @solidjs/web */
/** Subagent run names and source navigation for Solid UI. */
import { WandSparkles } from '@lucide/solid'
import { Show } from 'solid-js'
import type { JSX } from '@solidjs/web'
import { ROOT, events, useDocOf } from '@/sdk/solid'
import { RunsDoc } from './refs.ts'
import { agentSource } from './source.ts'

/** Show a run's label, the model it started on, and a wand for an ad hoc agent. */
export function RunName(props: { id?: number; label: JSX.Element }) {
  const runs = useDocOf(() => ROOT, RunsDoc)
  const run = () => runs()?.[String(props.id)]
  return (
    <>
      <Show when={run()?.adhoc}>
        <WandSparkles
          aria-label="Made on the fly"
          class="mr-1 inline size-3 shrink-0 align-[-2px] text-muted-foreground"
        >
          <title>Made on the fly, without a definition</title>
        </WandSparkles>
      </Show>
      {props.label}
      <Show when={run()?.model}>
        {(model) => <span class="text-muted-foreground/70"> · {model()}</span>}
      </Show>
    </>
  )
}

/** Open an agent's source conversation and remember where to return. */
export const openAgentSource = agentSource(events)
