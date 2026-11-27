import { ListFilterIcon } from '@lucide/solid'
import { For, Show, createMemo, createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { cn } from '@/sdk/solid'
import { percent, usd } from '../model/format.ts'
import type { ToolCost } from '../model/tools.ts'
import { ShareBar } from './breakdown.solid.tsx'
import { SortHead, sorted, useSort } from './sort.solid.tsx'
import type { Columns } from './sort.solid.tsx'

type ToolColumn = 'tool' | 'cost' | 'input' | 'rereads' | 'direct'
const COLUMNS: Columns<ToolColumn, ToolCost> = {
  tool: { value: (row) => row.tool },
  cost: { value: (row) => row.usd },
  input: { value: (row) => row.inputShare },
  rereads: { value: (row) => row.avgRereads },
  direct: { value: (row) => row.directUsd },
}

const FIRST = 12
const GRID =
  'grid grid-cols-[minmax(0,1fr)_4.75rem_6.5rem] items-center gap-x-3 @2xl:grid-cols-[minmax(0,1fr)_4.75rem_6.5rem_4.5rem_4.5rem_4.5rem]'

export function ToolTable(props: {
  rows: ToolCost[]
  total: number
  onFilter: (tool: string) => void
}) {
  const [all, setAll] = createSignal(false)
  const { sort, onSort } = useSort<ToolColumn>()
  const ordered = createMemo(() => sorted(props.rows, sort(), COLUMNS))
  const shown = () => (all() ? ordered() : ordered().slice(0, FIRST))
  const rest = () => Math.max(0, props.total - props.rows.reduce((sum, row) => sum + row.usd, 0))
  return (
    <Show
      when={props.rows.length}
      fallback={
        <p class="py-6 pl-2 font-mono text-[11.5px] text-muted-foreground/70">
          No tool results in these responses.
        </p>
      }
    >
      <div class="flex flex-col">
        <div
          class={cn(
            GRID,
            'h-7 border-b border-border/60 px-2 font-mono text-[10.5px] text-muted-foreground/70',
          )}
        >
          <SortHead class="pl-5" column="tool" onSort={onSort} sort={sort()} table="tools" text>
            tool
          </SortHead>
          <SortHead column="cost" onSort={onSort} right sort={sort()} table="tools">
            est. cost
          </SortHead>
          <span class="text-right">share</span>
          <SortHead
            class="hidden @2xl:block"
            column="input"
            onSort={onSort}
            right
            sort={sort()}
            table="tools"
            title="Its results' tokens over all prompt tokens"
          >
            of input
          </SortHead>
          <SortHead
            class="hidden @2xl:block"
            column="rereads"
            onSort={onSort}
            right
            sort={sort()}
            table="tools"
            title="How many prompts each result was sent in, on average"
          >
            re-reads
          </SortHead>
          <SortHead
            class="hidden @2xl:block"
            column="direct"
            onSort={onSort}
            right
            sort={sort()}
            table="tools"
            title="Spend inside the tool itself (model calls it made)"
          >
            direct
          </SortHead>
        </div>
        <div class="flex flex-col pt-1">
          <For each={shown()} keyed={(row) => row.tool}>
            {(row) => {
              const share = () => (props.total > 0 ? row().usd / props.total : 0)
              return (
                <div
                  class={cn(
                    GRID,
                    'group/row h-8 rounded-md px-2 font-mono text-[11.5px] text-foreground/85 tabular-nums hover:bg-muted/40',
                  )}
                  data-spend-tool={row().tool}
                >
                  <Button
                    aria-label={`Filter to tool ${row().tool} from the tools table`}
                    class="flex h-auto min-w-0 shrink items-center justify-start gap-2 text-[length:inherit] rounded-sm pl-5 text-left font-normal outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={() => props.onFilter(row().tool)}
                    size={null}
                    title={`Filter to ${row().tool}`}
                    variant={null}
                  >
                    <span class="min-w-0 truncate text-[12px] text-foreground/90 group-hover/row:text-foreground">
                      {row().tool}
                    </span>
                    <ListFilterIcon class="size-3 shrink-0 text-muted-foreground opacity-0 group-hover/row:opacity-100" />
                  </Button>
                  <span class="text-right text-foreground">{usd(row().usd)}</span>
                  <span class="flex items-center justify-end gap-2">
                    <ShareBar share={share()} />
                    <span class="w-11 text-right">{percent(share())}</span>
                  </span>
                  <span class="hidden text-right text-muted-foreground @2xl:block">
                    {percent(row().inputShare)}
                  </span>
                  <span class="hidden text-right text-muted-foreground @2xl:block">
                    {row().avgRereads > 0 ? `${row().avgRereads.toFixed(1)}×` : '—'}
                  </span>
                  <span class="hidden text-right text-muted-foreground @2xl:block">
                    {row().directUsd > 0 ? usd(row().directUsd) : '—'}
                  </span>
                </div>
              )
            }}
          </For>
        </div>
        <p class="mt-1 flex flex-wrap items-center gap-x-3 px-2 pl-7 font-mono text-[10.5px] text-muted-foreground/70">
          <span title="Prompts, replies and thinking not attributable to a tool's results or call arguments, and the overhead">
            rest of the spend {usd(rest())} · {percent(props.total > 0 ? rest() / props.total : 0)}
          </span>
          <Show when={props.rows.length > FIRST}>
            <Button
              aria-label={all() ? 'Show fewer tools' : `Show all ${props.rows.length} tools`}
              class="h-auto rounded-sm font-normal outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => setAll(!all())}
              size={null}
              variant={null}
            >
              {all() ? 'fewer' : `show all ${props.rows.length}`}
            </Button>
          </Show>
        </p>
      </div>
    </Show>
  )
}
