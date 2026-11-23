import { ChevronDownIcon } from '@lucide/solid'
import { For, Show } from 'solid-js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.solid.tsx'
import { cn } from '@/sdk/solid'
import { DIMENSIONS } from '../../model/dimensions.ts'
import type { Dimension } from '../../model/dimensions.ts'
import { dimensions } from '../../model/view.ts'
import { quiet } from '../parts.solid.tsx'

export function DimensionPicker(props: {
  value?: Dimension
  onChange: (dimension?: Dimension) => void
  none?: string
  exclude?: Dimension
  label: string
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={props.label}
        class={cn(quiet, props.value && 'text-foreground')}
      >
        {props.value ? DIMENSIONS[props.value].toLowerCase() : props.none}
        <ChevronDownIcon class="size-3 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-44">
        <DropdownMenuRadioGroup
          onValueChange={(next) => props.onChange(next === '' ? undefined : (next as Dimension))}
          value={props.value ?? ''}
        >
          <DropdownMenuLabel class="section-label">{props.label}</DropdownMenuLabel>
          <Show when={props.none}>
            {(none) => (
              <DropdownMenuRadioItem
                aria-label={`${props.label} ${none()}`}
                class="text-[12.5px]"
                value=""
              >
                {none()}
              </DropdownMenuRadioItem>
            )}
          </Show>
          <For each={dimensions.filter((dimension) => dimension !== props.exclude)}>
            {(dimension) => (
              <DropdownMenuRadioItem
                aria-label={`${props.label} ${DIMENSIONS[dimension]}`}
                class="text-[12.5px]"
                value={dimension}
              >
                {DIMENSIONS[dimension]}
              </DropdownMenuRadioItem>
            )}
          </For>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
