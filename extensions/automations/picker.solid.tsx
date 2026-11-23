import { Bot, ChevronDown, SlidersHorizontal } from '@lucide/solid'
import { For, Show } from 'solid-js'
import type { JSX } from '@solidjs/web'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.solid.tsx'
import { ROOT, cn, keepLast, useAction } from '@/sdk/solid'
import { DefinitionsAction } from '../subagents/refs.ts'

export function Picker(props: {
  label: string
  value: string
  onChange: (value: string) => void
  children: JSX.Element
  selection: JSX.Element
  class?: string
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={props.label}
        class={cn(
          'flex h-8 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-transparent px-2.5 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          props.class,
        )}
      >
        {props.selection}
        <ChevronDown aria-hidden="true" class="ml-auto size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="max-h-72 min-w-52 overflow-y-auto">
        <DropdownMenuRadioGroup
          value={props.value}
          onValueChange={(value) => props.onChange(value)}
        >
          {props.children}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type Profile = { model?: { modelId: string }; thinking?: string }
const model = (profile: Profile | undefined, fallback: string) =>
  profile?.model
    ? `${profile.model.modelId}${profile.thinking ? ` · ${profile.thinking}` : ''}`
    : fallback

export function AgentPicker(props: {
  value: string
  onChange: (name: string) => void
  onConfigure: (name: string, source: string, refresh: () => void) => void
}) {
  const { data, refetch } = useAction(DefinitionsAction, null, {
    conversation: ROOT,
    onError: keepLast,
  })
  const chosen = () => data()?.definitions.find((definition) => definition.name === props.value)
  const main = () => model(data()?.main, "the main conversation's model")
  const inherits = () => `inherits · ${data()?.main?.model?.modelId ?? 'main'}`
  return (
    <div class="flex gap-2">
      <Picker
        label="Run agent"
        value={props.value}
        onChange={props.onChange}
        selection={
          <>
            <Bot aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="shrink-0 text-foreground/90">{props.value || 'Main agent'}</span>
            <span class="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
              {props.value
                ? chosen()
                  ? model(chosen(), inherits())
                  : 'not found'
                : `a copy of main · ${main()}`}
            </span>
          </>
        }
      >
        <DropdownMenuRadioItem closeOnSelect value="">
          Main agent · {main()}
        </DropdownMenuRadioItem>
        <For each={data()?.definitions} keyed={(definition) => definition.name}>
          {(definition) => (
            <DropdownMenuRadioItem
              class="items-start text-[12.5px]"
              closeOnSelect
              value={definition().name}
            >
              <span class="flex min-w-0 flex-1 flex-col">
                <span class="flex items-baseline gap-2 font-mono">
                  {definition().name}
                  <span class="ml-auto truncate text-[10.5px] text-muted-foreground">
                    {model(definition(), inherits())}
                  </span>
                </span>
                <span class="line-clamp-2 text-[11.5px] text-muted-foreground">
                  {definition().description}
                </span>
              </span>
            </DropdownMenuRadioItem>
          )}
        </For>
        <Show when={props.value && !chosen() && data()}>
          <DropdownMenuRadioItem closeOnSelect class="text-error" value={props.value}>
            {props.value} (not found)
          </DropdownMenuRadioItem>
        </Show>
      </Picker>
      <Show when={chosen()}>
        {(definition) => (
          <Button
            class="h-8 shrink-0 gap-1.5 px-2.5 text-[12px]"
            data-automation-configure
            onClick={(_, details) => props.onConfigure(definition().name, details.source, refetch)}
            size="sm"
            title={`Open the ${definition().name} definition: model, thinking, tools, and instructions`}
            variant="outline"
          >
            <SlidersHorizontal aria-hidden="true" class="size-3.5" /> Configure
          </Button>
        )}
      </Show>
    </div>
  )
}
