import { LoaderCircleIcon } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { For, Show } from 'solid-js'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control.solid.tsx'
import { cn, useAction, useSystem } from '@/sdk/solid'
import type { ExtensionInfo, SystemInfo } from '../../shared/protocol.ts'
import { ExtensionsAction } from './refs.ts'

export const sources: Record<ExtensionInfo['source'], string> = {
  builtin: 'built-in',
  user: 'yours',
  project: 'this project',
}

export function useDescribed() {
  const system = useSystem()
  const described = useAction(ExtensionsAction, null, {
    on: () => system()?.extensions.map((extension) => extension.path),
  })
  const entry = (name: string) => described.data()?.find((candidate) => candidate.name === name)
  return {
    line: (name: string, source?: ExtensionInfo['source']) => {
      const known = entry(name)
      if (known && (!source || known.source === source)) return known.readme
      const readme = system()?.extensions.find((extension) => extension.name === name)?.readme
      return readme && !readme.startsWith('#') ? readme : ''
    },
    replaces: (name: string) => entry(name)?.replaces === 'builtin',
  }
}

export function projectLists(system: SystemInfo) {
  const extensions = system.project.settings.extensions
  const names = (key: string) => {
    const value =
      extensions && typeof extensions === 'object' && !Array.isArray(extensions)
        ? extensions[key]
        : undefined
    return Array.isArray(value)
      ? value.filter((name): name is string => typeof name === 'string')
      : []
  }
  return { enable: names('enable'), disable: names('disable') }
}

export function Line(props: { text: string; class?: string }) {
  return (
    <Show when={props.text}>
      {(text) => (
        <span class={props.class} title={text().replaceAll('`', '')}>
          <For each={text().split('`')} keyed={false}>
            {(part, index) =>
              index % 2 ? (
                <code class="font-mono text-[0.92em] text-foreground/75">{part()}</code>
              ) : (
                <>{part()}</>
              )
            }
          </For>
        </span>
      )}
    </Show>
  )
}

export function Heading(props: { children: JSX.Element; meta?: JSX.Element; class?: string }) {
  return (
    <div class={cn('flex items-center gap-2 section-label', props.class)}>
      {props.children}
      <Show when={props.meta !== undefined}>
        <span class="ml-auto truncate pl-2 text-muted-foreground/70">{props.meta}</span>
      </Show>
    </div>
  )
}

export function Segmented<T extends string>(props: {
  value: T | null
  options: readonly {
    value: T
    label: string
    busy?: boolean
    disabled?: boolean
    title?: string
  }[]
  onChange: (value: T) => void
  label: string
  class?: string
}) {
  return (
    <SegmentedControl<T>
      aria-label={props.label}
      class={cn('border-border/80 bg-background', props.class)}
      value={props.value}
      onValueChange={(value) => {
        if (value !== null) props.onChange(value)
      }}
    >
      <For each={props.options} keyed={(option) => option.value}>
        {(option) => (
          <SegmentedControlItem
            class="flex-1 justify-center gap-1.5 rounded-[5px] px-2 whitespace-nowrap data-checked:shadow-xs"
            value={option().value}
            disabled={option().disabled}
            title={option().title}
          >
            <Show when={option().busy}>
              <LoaderCircleIcon class="size-3 animate-spin" />
            </Show>
            {option().label}
          </SegmentedControlItem>
        )}
      </For>
    </SegmentedControl>
  )
}
