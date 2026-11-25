import type { EntryRecord } from '@earendil-works/pi-durable'
import type { JSX } from '@solidjs/web'
import { Show, createMemo } from 'solid-js'
import { cn, useConversationSummary, useDocOf } from '@/sdk/solid'
import { DEFAULT_FAMILY, familyColor, familyTitle } from '../../lib/families.ts'
import { AgentMark, AgentTitle } from '../conversations/ui.solid.tsx'
import { FamilyDoc } from '../models/refs.ts'
import { useFamilies } from '../models/ui.solid.tsx'
import { useAccentOf } from './card-parts.solid.tsx'
import { useStandingName } from './standing-name.solid.tsx'

const titleClass = 'font-sans text-[13px] font-semibold tracking-[-0.005em]'

export function Speaker(props: { entry: EntryRecord; core: JSX.Element }) {
  const agent = useStandingName(() => props.entry.conversationId)
  const accent = useAccentOf(() => props.entry.conversationId)
  return (
    <Show when={agent()} fallback={<FamilySpeaker entry={props.entry} core={props.core} />}>
      {(name) => (
        <span class="flex shrink-0 items-center gap-2" data-speaker={name()} title={`@${name()}`}>
          <AgentMark name={name()} />
          <span class={cn(titleClass, accent().name)}>
            <AgentTitle name={name()} />
          </span>
        </span>
      )}
    </Show>
  )
}

function FamilySpeaker(props: { entry: EntryRecord; core: JSX.Element }) {
  const recorded = useDocOf(() => props.entry.conversationId, FamilyDoc)
  const families = useFamilies()
  const conversation = useConversationSummary(() => props.entry.conversationId)
  const family = createMemo(() => {
    const name = recorded()?.name ?? DEFAULT_FAMILY
    return families()?.families.find((item) => item.name === name)
  })
  return (
    <Show when={family()} fallback={props.core}>
      {(item) => {
        const color = () => familyColor(item().color)
        const title = () => familyTitle(item().name)
        return (
          <span class="flex shrink-0 items-center gap-2" data-speaker={item().name}>
            <span
              aria-hidden="true"
              class="inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] font-sans text-[9.5px] leading-none font-semibold ring-1 ring-inset"
              style={{
                color: color(),
                'background-color': `color-mix(in srgb, ${color()} 12%, transparent)`,
                '--tw-ring-color': `color-mix(in srgb, ${color()} 25%, transparent)`,
              }}
            >
              {title().charAt(0)}
            </span>
            <span class={titleClass} style={{ color: color() }}>
              {title()}
            </span>
            <Show when={conversation()?.label}>
              {(label) => <span class="text-muted-foreground/70">{label()}</span>}
            </Show>
          </span>
        )
      }}
    </Show>
  )
}
