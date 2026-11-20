/** @jsxImportSource @solidjs/web */
/** Subagents for Solid code: a child's display name and opening the primary standing agent. */
import { WandSparkles } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { Show } from 'solid-js'
import { ROOT, api, useDocOf, writerNow, writingAs } from '@/sdk/solid'
import type { UltimateActions } from '@/sdk'
import { RunsDoc, StandingAction } from './refs.ts'

/** Open the primary agent's standing conversation on the Agent surface. */
export async function talkToUltimate(
  actions: Pick<UltimateActions, 'switchConversation' | 'showSurface'>,
) {
  const who = writerNow()
  const id = await api.action(StandingAction, { name: 'ultimate' })
  writingAs(who, () => {
    actions.switchConversation(id)
    actions.showSurface('agent')
  })
}

/** A child's label, the model it started on, and a wand if it was made without a definition. */
export function RunName(props: { id: number | undefined; label: JSX.Element }) {
  const runs = useDocOf(() => ROOT, RunsDoc)
  const run = () => (props.id === undefined ? undefined : runs()?.[props.id])
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
