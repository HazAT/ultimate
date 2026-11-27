import type { EntryRecord } from '@earendil-works/pi-durable'
import { Dynamic } from '@solidjs/web'
import type { JSX } from '@solidjs/web'
import { Show, createMemo } from 'solid-js'
import type { Component } from 'solid-js'
import { cn, useConversationSummary, useDocOf, useProvided } from '@/sdk/solid'
import { familyColor, familyTitle } from '../../lib/families.shared.ts'
import { AgentMark, AgentTitle } from '../conversations/ui.solid.tsx'
import { FamilyDoc } from '../models/refs.ts'
import { useFamilies } from '../models/ui.solid.tsx'
import { useAccentOf } from './card-parts.solid.tsx'
import { ExternalSpeaker } from './points.web.ts'
import { useStandingName } from './standing-name.solid.tsx'

const titleClass = 'font-sans text-[13px] font-semibold tracking-[-0.005em]'

export function Speaker(props: { entry: EntryRecord; core: JSX.Element }) {
  const agent = useStandingName(() => props.entry.conversationId)
  const accent = useAccentOf(() => props.entry.conversationId)
  return (
    <Show when={agent()} fallback={<FamilySpeaker entry={props.entry} core={props.core} />}>
      {(name) => (
        <span class="flex min-w-0 items-center gap-2" data-speaker={name()} title={`@${name()}`}>
          <AgentMark name={name()} />
          <span class={cn(titleClass, 'min-w-0 truncate', accent().name)}>
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
  const external = useProvided(ExternalSpeaker, () => props.entry)
  const family = createMemo(() => {
    const name = recorded()?.name
    return name ? families()?.families.find((item) => item.name === name) : undefined
  })
  const speaker = createMemo(() => {
    const outside = external()
    if (outside) return { ...outside, color: undefined }
    const item = family()
    if (item) return { name: item.name, title: familyTitle(item.name), color: item.color }
    const label = recorded() === undefined ? undefined : conversation()?.label
    return label ? { name: label, title: familyTitle(label), color: undefined } : undefined
  })
  return (
    <Show when={speaker()} fallback={props.core}>
      {(item) => (
        <SpeakerBadge
          color={item().color}
          icon={external()?.icon}
          name={item().name}
          role={
            external()?.model
              ? `· ${external()?.model}`
              : !external() && family()
                ? conversation()?.label
                : undefined
          }
          title={item().title}
        />
      )}
    </Show>
  )
}

export function SpeakerBadge(props: {
  name: string
  title: string
  color?: string
  icon?: Component<{ class?: string }>
  role?: string
}) {
  const color = () => familyColor(props.color)
  return (
    <span class="flex min-w-0 items-center gap-2" data-speaker={props.name}>
      <span
        aria-hidden="true"
        class="inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] font-sans text-[9.5px] leading-none font-semibold ring-1 ring-inset"
        style={{
          color: color(),
          'background-color': `color-mix(in srgb, ${color()} 12%, transparent)`,
          '--tw-ring-color': `color-mix(in srgb, ${color()} 25%, transparent)`,
        }}
      >
        <Show when={props.icon} fallback={props.title.charAt(0)}>
          {(icon) => <Dynamic class="size-3" component={icon()} />}
        </Show>
      </span>
      <span class={cn(titleClass, 'min-w-0 truncate')} style={{ color: color() }}>
        {props.title}
      </span>
      <Show when={props.role}>
        {(label) => (
          <span class="min-w-0 truncate text-muted-foreground/70" title={label()}>
            {label()}
          </span>
        )}
      </Show>
    </span>
  )
}
