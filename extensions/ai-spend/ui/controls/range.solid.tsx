import { CalendarIcon } from '@lucide/solid'
import { For, createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Form } from '@/components/ui/form.solid.tsx'
import { Input } from '@/components/ui/input.solid.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control.solid.tsx'
import { cn } from '@/sdk/solid'
import { dayKey } from '../../model/calendar.ts'
import { RANGES } from '../../model/view.ts'
import type { RangeKind, View } from '../../model/view.ts'

export const segment =
  'h-6 rounded-md px-2 font-mono text-[11.5px] whitespace-nowrap transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring'
const off = 'text-muted-foreground hover:text-foreground'
const on = 'bg-accent text-foreground'

const presets = Object.keys(RANGES) as (keyof typeof RANGES)[]

export function RangePicker(props: {
  view: View
  onChange: (range: Partial<View>) => void
  now: number
}) {
  const [open, setOpen] = createSignal(false)
  const [from, setFrom] = createSignal('')
  const [to, setTo] = createSignal('')
  const today = () => dayKey(props.now)
  const custom = () => props.view.range === 'custom'
  return (
    <div class="flex items-center gap-0.5">
      <SegmentedControl<RangeKind>
        aria-label="Range"
        class="gap-0.5 border-0 p-0"
        onValueChange={(range) => range && props.onChange({ range, bucket: undefined })}
        value={custom() ? null : props.view.range}
      >
        <For each={presets}>
          {(range) => (
            <SegmentedControlItem class={cn(segment, 'gap-0 px-2 text-[11.5px]')} value={range}>
              {RANGES[range]}
            </SegmentedControlItem>
          )}
        </For>
      </SegmentedControl>
      <Popover
        onOpenChange={(next) => {
          setOpen(next)
          if (next) {
            setFrom(props.view.from ?? dayKey(props.now - 13 * 86_400_000))
            setTo(props.view.to ?? today())
          }
        }}
        open={open()}
      >
        <PopoverTrigger
          aria-label="Custom range"
          class={cn(segment, 'flex items-center gap-1', custom() ? on : off)}
        >
          <CalendarIcon class="size-3" />
          {custom() && props.view.from && props.view.to
            ? `${props.view.from.slice(5)} – ${props.view.to.slice(5)}`
            : 'custom'}
        </PopoverTrigger>
        <PopoverContent align="start" aria-label="Custom range" class="w-64 p-3">
          <Form class="flex flex-col gap-2.5">
            <p class="section-label">Custom range</p>
            <DateField label="from" max={to()} onChange={setFrom} value={from()} />
            <DateField label="to" max={today()} min={from()} onChange={setTo} value={to()} />
            <Button
              class="mt-1 h-7 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                props.onChange({ range: 'custom', from: from(), to: to(), bucket: undefined })
                setOpen(false)
              }}
              size={null}
              type="submit"
              variant={null}
            >
              Show these days
            </Button>
          </Form>
        </PopoverContent>
      </Popover>
    </div>
  )
}

function DateField(props: {
  label: string
  value: string
  onChange: (value: string) => void
  min?: string
  max?: string
}) {
  return (
    <label class="flex items-center gap-2 font-mono text-[11.5px] text-muted-foreground">
      <span class="w-9">{props.label}</span>
      <Input
        aria-label={`Range ${props.label}`}
        class="h-7 min-w-0 flex-1 rounded-md border border-border/70 bg-transparent px-2 text-[11.5px] text-foreground focus-visible:ring-0 [color-scheme:inherit]"
        max={props.max}
        min={props.min}
        onValueChange={(value) => value && props.onChange(value)}
        required
        type="date"
        value={props.value}
      />
    </label>
  )
}
