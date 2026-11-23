import { Show, createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Form } from '@/components/ui/form.solid.tsx'
import { Input } from '@/components/ui/input.solid.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import { cn } from '@/sdk/solid'
import { usdShort, whole } from '../../model/format.ts'
import type { Budget } from '../../model/view.ts'
import { quiet } from '../parts.solid.tsx'

const parse = (text: string) => {
  const value = Number(text)
  return text.trim() && Number.isFinite(value) && value > 0 ? value : undefined
}

const amount = (value: number) => (value >= 10 ? whole(value) : usdShort(value))

const textOf = (value?: number) => value?.toString() ?? ''

export function BudgetButton(props: { budget: Budget; onChange: (budget: Budget) => void }) {
  const [open, setOpen] = createSignal(false)
  const [day, setDay] = createSignal('')
  const [week, setWeek] = createSignal('')
  const [month, setMonth] = createSignal('')
  const set = () =>
    [
      props.budget.day && `${amount(props.budget.day)}/day`,
      props.budget.week && `${amount(props.budget.week)}/wk`,
      props.budget.month && `${amount(props.budget.month)}/mo`,
    ]
      .filter(Boolean)
      .join(' · ')
  const save = (budget: Budget) => {
    props.onChange(budget)
    setOpen(false)
  }
  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setDay(textOf(props.budget.day))
          setWeek(textOf(props.budget.week))
          setMonth(textOf(props.budget.month))
        }
      }}
      open={open()}
    >
      <PopoverTrigger
        class={cn(quiet, set() && 'text-foreground/85')}
        title="A budget the forecast is checked against"
      >
        {set() ? `budget ${set()}` : 'set budget'}
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Budget" class="w-64 p-3">
        <Form class="flex flex-col gap-2.5">
          <div>
            <p class="section-label">Budget</p>
            <p class="mt-0.5 text-[12px] leading-snug text-muted-foreground">
              Days over the daily one and week or month forecasts past theirs turn amber. Leave one
              empty to skip it.
            </p>
          </div>
          <MoneyField label="day" onChange={setDay} value={day()} />
          <MoneyField label="week" onChange={setWeek} value={week()} />
          <MoneyField label="month" onChange={setMonth} value={month()} />
          <div class="mt-1 flex items-center gap-2">
            <Show when={props.budget.day || props.budget.week || props.budget.month}>
              <Button
                aria-label="Clear the budget"
                class="h-7 rounded-md px-2 font-mono text-[11.5px] font-normal text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => save({})}
                size={null}
                variant={null}
              >
                clear
              </Button>
            </Show>
            <Button
              class="ml-auto h-7 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() =>
                save({ day: parse(day()), week: parse(week()), month: parse(month()) })
              }
              size={null}
              type="submit"
              variant={null}
            >
              Save budget
            </Button>
          </div>
        </Form>
      </PopoverContent>
    </Popover>
  )
}

function MoneyField(props: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label class="flex items-center gap-2 font-mono text-[11.5px] text-muted-foreground">
      <span class="w-11">{props.label}</span>
      <span class="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md border border-border/70 px-2 focus-within:border-ring">
        $
        <Input
          aria-label={`Budget per ${props.label}`}
          class="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-[11.5px] text-foreground tabular-nums placeholder:text-muted-foreground/50 focus-visible:ring-0"
          inputmode="decimal"
          onValueChange={(value) => props.onChange(value)}
          placeholder="none"
          value={props.value}
        />
      </span>
    </label>
  )
}
