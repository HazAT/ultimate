/** @jsxImportSource @solidjs/web */
import type { JSX } from '@solidjs/web'
import { createMemo, createSignal, For, Match, Show, Switch as Branch } from 'solid-js'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import { Checkbox } from '@/components/ui/checkbox.solid.tsx'
import { Textarea } from '@/components/ui/input.solid.tsx'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control.solid.tsx'
import { Switch } from '@/components/ui/switch.solid.tsx'
import type { ModelsResponse } from '@/sdk/solid'
import { cn } from '@/sdk/solid'
import type { ModelRef } from './refs.ts'

export function Field(props: {
  label: string
  hint?: JSX.Element
  aside?: JSX.Element
  children: JSX.Element
}) {
  return (
    <div class="flex flex-col gap-1.5">
      <div class="flex items-center gap-2 section-label">
        {props.label}
        <span class="ml-auto empty:hidden">{props.aside}</span>
      </div>
      {props.children}
      <p class="text-[11.5px] leading-snug text-muted-foreground/80 empty:hidden">{props.hint}</p>
    </div>
  )
}

export function ToggleField(props: {
  label: string
  text: string
  hint: string
  value: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <Field label={props.label} hint={props.hint}>
      <label class="flex items-center justify-between rounded-md border border-border/80 bg-background px-2 py-1.5 text-[13px]">
        {props.text}
        <Switch
          aria-label={props.label}
          checked={props.value}
          onCheckedChange={(value) => props.onChange(value)}
        />
      </label>
    </Field>
  )
}

export const inputClass =
  'w-full rounded-md border border-border/80 bg-background px-2 py-1.5 text-[13px] outline-none placeholder:text-muted-foreground/50 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-error/70'

export function Segmented<T extends string>(props: {
  value: T
  options: readonly { value: T; label?: string; title?: string; disabled?: boolean }[]
  onChange: (value: T) => void
  label: string
  tabs?: boolean
}) {
  return (
    <SegmentedControl
      aria-label={props.label}
      bind={[() => props.value, (value) => props.onChange(value)]}
      class={props.tabs ? 'gap-1 border-0 p-0' : 'flex-wrap bg-background'}
    >
      <For each={props.options} keyed={(item) => item.value}>
        {(item) => (
          <SegmentedControlItem
            aria-label={`${item().label ?? item().value} · ${props.label} option`}
            class={
              props.tabs
                ? 'rounded-[5px] px-2'
                : 'flex-1 justify-center rounded-[5px] whitespace-nowrap data-checked:shadow-xs'
            }
            disabled={item().disabled}
            title={item().title}
            value={item().value}
          >
            {item().label ?? item().value}
          </SegmentedControlItem>
        )}
      </For>
    </SegmentedControl>
  )
}

const piLevelsForUncataloguedModel = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function thinkingLevels(models: ModelsResponse | undefined, ref: ModelRef | undefined) {
  return (
    models?.models.find((model) => model.provider === ref?.provider && model.id === ref.modelId)
      ?.thinkingLevels ?? piLevelsForUncataloguedModel
  )
}

export function ResourcesField(props: {
  kind: 'tool' | 'skill'
  value: string[] | null
  resources: { name: string; description: string }[]
  onChange: (value: string[] | null) => void
}) {
  const tools = () => props.kind === 'tool'
  const names = createMemo(() => props.resources.map((item) => item.name))
  const inherited = createMemo(() =>
    tools() ? names().filter((name) => name !== 'subagent') : names(),
  )
  const selected = () => props.value ?? inherited()
  const unknown = createMemo(() => (props.value ?? []).filter((name) => !names().includes(name)))
  const hint = () =>
    tools()
      ? props.value === null
        ? `${inherited().length} of ${names().length} tools inherited from the main conversation; subagent requires explicit selection.`
        : `${props.value.length} of ${names().length} tools selected. Select subagent explicitly to allow child delegation.`
      : props.value === null
        ? `Every project skill (${names().length}), including ones added later.`
        : `${props.value.length} of ${names().length} skills listed in its prompt. /skill:name still runs any skill.`
  const toggle = (name: string, on: boolean) => {
    const value = props.value
    if (value)
      props.onChange(
        on
          ? names().filter((item) => item === name || value.includes(item))
          : value.filter((item) => item !== name),
      )
  }
  return (
    <Field
      aside={
        <label class="flex items-center gap-1.5 font-sans text-[11.5px] text-muted-foreground">
          {tools() ? 'inherit all' : 'all skills'}
          <Switch
            checked={props.value === null}
            aria-label={tools() ? 'Inherit all tools' : 'All skills'}
            onCheckedChange={(on) => props.onChange(on ? null : inherited())}
          />
        </label>
      }
      hint={hint()}
      label={tools() ? 'Tools' : 'Skills'}
    >
      <div
        class={cn(
          'grid grid-cols-2 gap-x-3 gap-y-0.5 rounded-md border border-border/70 px-2 py-1.5 font-mono text-[11.5px]',
          props.value === null && 'opacity-50',
        )}
      >
        <For each={props.resources} keyed={(item) => item.name}>
          {(item) => (
            <label class="flex min-w-0 items-center gap-1.5 py-0.5" title={item().description}>
              <Checkbox
                aria-label={`Allow ${item().name} ${props.kind} access`}
                bind={[() => selected().includes(item().name), (on) => toggle(item().name, on)]}
                class="size-3 [&_svg]:size-2.5"
                disabled={props.value === null}
              />
              <span class="truncate">{item().name}</span>
            </label>
          )}
        </For>
        <For each={unknown()}>
          {(name) => (
            <label
              class="flex min-w-0 items-center gap-1.5 py-0.5 text-error"
              title={
                tools()
                  ? 'Not a tool of the main conversation: start refuses this definition'
                  : 'No skill of this name: the agent gets nothing for it'
              }
            >
              <Checkbox
                aria-label={`Drop ${name} unknown ${props.kind}`}
                class="size-3 data-checked:border-error data-checked:bg-error [&_svg]:size-2.5"
                checked
                onCheckedChange={() => toggle(name, false)}
              />
              <span class="truncate">{name}</span>
            </label>
          )}
        </For>
      </div>
    </Field>
  )
}

const tabs = [
  { value: 'write', label: 'Write' },
  { value: 'preview', label: 'Preview' },
  { value: 'file', label: 'File' },
] as const

export function InstructionsEditor(props: {
  value: string
  onChange: (value: string) => void
  file?: string
}) {
  const [selected, select] = createSignal<(typeof tabs)[number]['value']>('write')
  const tab = () => (selected() === 'file' && props.file === undefined ? 'write' : selected())
  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border/80 bg-background focus-within:border-ring">
      <div class="flex items-center gap-1 border-b border-border/70 px-1.5 py-1 font-mono text-[11px]">
        <Segmented
          label="Prompt view"
          onChange={select}
          options={props.file === undefined ? tabs.slice(0, 2) : tabs}
          tabs
          value={tab()}
        />
        <span class="ml-auto pr-1.5 text-muted-foreground/70">Markdown · the system prompt</span>
      </div>
      <Branch>
        <Match when={tab() === 'write'}>
          <Textarea
            aria-label="Instructions"
            class="min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent p-3 font-mono text-[12.5px] focus-visible:ring-0"
            onValueChange={(value) => props.onChange(value)}
            placeholder="What this agent does and how it reports back…"
            value={props.value}
          />
        </Match>
        <Match when={tab() === 'preview'}>
          <div class="min-h-0 flex-1 overflow-y-auto p-3 text-[13px]">
            <Show
              when={props.value.trim()}
              fallback={<p class="text-muted-foreground/70">Nothing to preview.</p>}
            >
              <Markdown text={props.value} />
            </Show>
          </div>
        </Match>
        <Match when={tab() === 'file'}>
          <pre class="min-h-0 flex-1 overflow-auto p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {props.file}
          </pre>
        </Match>
      </Branch>
    </div>
  )
}
