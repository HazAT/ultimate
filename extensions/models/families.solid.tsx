import { createMemo, Show } from 'solid-js'
import { api, cn, useExternal } from '@/sdk/solid'
import { DEFAULT_FAMILY, familyColor, familyTitle } from '../../lib/families.shared.ts'
import { modelIdOf, refresh, runsOn } from './family-state.web.ts'
import { FamilyDot, useFamilies } from './readers.solid.tsx'
import { FamiliesAction } from './refs.ts'
import { picks } from './state.web.ts'

export const refreshFamilies = () => refresh(() => api.action(FamiliesAction, null))
export const usePicks = () => useExternal(picks.get, picks.subscribe)

export function FamilyLabel(props: { family: string | undefined; class?: string }) {
  const families = useFamilies()
  const name = () => props.family ?? DEFAULT_FAMILY
  const family = createMemo(() => families()?.families.find((item) => item.name === name()))
  return (
    <Show when={family()} fallback={<span class={props.class}>{familyTitle(name())}</span>}>
      {(item) => (
        <span class={cn('inline-flex min-w-0 items-center gap-1.5', props.class)}>
          <FamilyDot color={item().color} />
          <span class="truncate">
            <span style={{ color: familyColor(item().color) }}>{familyTitle(item().name)}</span>
            <Show when={runsOn(item())}>
              {(model) => <span class="text-muted-foreground"> ({modelIdOf(model())})</span>}
            </Show>
          </span>
        </span>
      )}
    </Show>
  )
}
