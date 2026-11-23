import { AlertTriangleIcon, CoinsIcon, DownloadIcon, RotateCwIcon } from '@lucide/solid'
import { For, Show, createMemo } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control.solid.tsx'
import { cn, formatAgo, useExtensionUiState, useNow } from '@/sdk/solid'
import { cache } from '../model/cache.ts'
import { csv } from '../model/csv.ts'
import { daily } from '../model/daily.ts'
import { DIMENSIONS, OTHER } from '../model/dimensions.ts'
import type { Dimension } from '../model/dimensions.ts'
import { forecast } from '../model/forecast.ts'
import { dateLabel } from '../model/format.ts'
import { group } from '../model/groups.ts'
import type { Group } from '../model/groups.ts'
import { labeller } from '../model/labels.ts'
import { series } from '../model/series.ts'
import { summary } from '../model/summary.ts'
import { tools } from '../model/tools.ts'
import { turns } from '../model/turns.ts'
import { refOf } from '../model/types.ts'
import type { SpendData } from '../model/types.ts'
import {
  DEFAULT_VIEW,
  activeFilters,
  bucketOf,
  buckets,
  clip,
  filterOf,
  rangeLabel,
  windowOf,
} from '../model/view.ts'
import type { Bucket, Budget, View } from '../model/view.ts'
import { Breakdown, columnsOf, orderGroups } from './breakdown.solid.tsx'
import type { BreakdownColumn, RowHandlers } from './breakdown.solid.tsx'
import { CacheView } from './cache.solid.tsx'
import { SpendChart, TOP } from './chart.solid.tsx'
import { BudgetButton } from './controls/budget.solid.tsx'
import { DimensionPicker } from './controls/dimension.solid.tsx'
import { AddFilter, Chip } from './controls/filters.solid.tsx'
import { RangePicker, segment } from './controls/range.solid.tsx'
import { SpendFrame, SpendTitle } from './frame.solid.tsx'
import { Loading, page } from './loading.solid.tsx'
import { Estimate, Section, quiet } from './parts.solid.tsx'
import { sorted, useSort } from './sort.solid.tsx'
import { useSpend } from './store.ts'
import type { Spend as SpendState } from './store.ts'
import { Band } from './summary.solid.tsx'
import { ToolTable } from './tools.solid.tsx'
import { TurnList } from './turns.solid.tsx'

const DRILL: Record<Dimension, Dimension> = {
  tree: 'conversation',
  conversation: 'model',
  agent: 'conversation',
  model: 'agent',
  provider: 'model',
  vendor: 'model',
  family: 'agent',
  kind: 'model',
  thinking: 'model',
  cache: 'conversation',
  prompt: 'conversation',
  status: 'conversation',
  tool: 'conversation',
  hour: 'conversation',
  day: 'conversation',
  week: 'day',
}

export default function SpendSurface() {
  const spend = useSpend()
  return (
    <SpendFrame
      header={
        <>
          <SpendTitle />
          <ReadState spend={spend} />
        </>
      }
    >
      <Show
        when={spend.data()}
        fallback={
          <Show when={spend.error()} fallback={<Loading />}>
            {(error) => <Failed error={error()} onRetry={() => void spend.refresh()} />}
          </Show>
        }
      >
        {(data) => (
          <Show when={data().rows.length} fallback={<Empty />}>
            <Spend data={data()} />
          </Show>
        )}
      </Show>
    </SpendFrame>
  )
}

function ReadState(props: { spend: SpendState }) {
  const now = useNow(10_000)
  return (
    <span class="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground/70">
      <Show when={props.spend.readAt()}>
        {(readAt) => <span class="truncate">read {formatAgo(readAt(), now(), { ago: true })}</span>}
      </Show>
      <Show when={props.spend.data() && props.spend.error()}>
        {(error) => (
          <span class="flex items-center gap-1 text-error" title={error()}>
            <AlertTriangleIcon class="size-3" />
            last read failed
          </span>
        )}
      </Show>
      <Button
        aria-label="Read again"
        class="flex size-5 items-center justify-center rounded-sm outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-100 data-disabled:opacity-100"
        disabled={props.spend.reading()}
        onClick={() => void props.spend.refresh()}
        size={null}
        title="Read again"
        variant={null}
      >
        <RotateCwIcon class={cn('size-3', props.spend.reading() && 'animate-spin')} />
      </Button>
    </span>
  )
}

function Empty() {
  return (
    <div class="flex min-h-0 flex-1 items-center justify-center p-6" data-spend-empty>
      <div class="flex max-w-sm flex-col items-center gap-2 text-center">
        <CoinsIcon class="size-5 text-muted-foreground/60" />
        <p class="text-[13.5px] font-medium text-foreground">No spend yet</p>
        <p class="text-[12.5px] leading-snug text-muted-foreground">
          Every model response an agent gets is counted here with the tokens and dollars it
          recorded, by conversation, agent, model and tool.
        </p>
      </div>
    </div>
  )
}

function Failed(props: { error: string; onRetry: () => void }) {
  return (
    <div class="flex min-h-0 flex-1 items-center justify-center p-6">
      <div class="flex max-w-md flex-col items-center gap-2 text-center">
        <AlertTriangleIcon class="size-5 text-error/80" />
        <p class="text-[13.5px] font-medium text-foreground">Spend could not be read</p>
        <p class="font-mono text-[11.5px] break-words text-muted-foreground">{props.error}</p>
        <Button
          class={cn(quiet, 'mt-1 border border-border/70')}
          onClick={() => props.onRetry()}
          size={null}
          variant={null}
        >
          <RotateCwIcon class="size-3" />
          try again
        </Button>
      </div>
    </div>
  )
}

function download(name: string, text: string) {
  const link = document.createElement('a')
  link.href = `data:text/csv;charset=utf-8,${encodeURIComponent(text)}`
  link.download = name
  link.click()
}

const sum = (groups: Group[]) => groups.reduce((total, g) => total + g.usd, 0)

function Spend(props: { data: SpendData }) {
  const [stored, setView] = useExtensionUiState<View>('view', DEFAULT_VIEW)
  const [budget, setBudget] = useExtensionUiState<Budget>('budget', {})
  const view = createMemo<View>(() => ({
    ...DEFAULT_VIEW,
    ...stored(),
    filters: stored().filters ?? {},
  }))
  const now = useNow(60_000)
  const minute = createMemo(() => Math.floor(now() / 60_000) * 60_000)
  const update = (change: Partial<View>) => setView({ ...view(), ...change })

  const conversations = createMemo(() => new Map(props.data.conversations.map((c) => [c.id, c])))
  const branching = createMemo(
    () => new Set(props.data.conversations.filter((c) => c.root !== c.id).map((c) => c.root)),
  )
  const label = createMemo(() => labeller(props.data))

  const full = createMemo(() => windowOf(view(), minute(), props.data.since))
  const win = createMemo(() => clip(full(), minute(), props.data.since))
  const clipped = () => win().from !== full().from
  const filter = createMemo(() => filterOf(win(), view().filters))
  const allowed = createMemo(() => buckets(win()))
  const bucket = createMemo(() => bucketOf(view(), win(), allowed()))

  const totals = createMemo(() => summary(props.data, filter()))
  const previous = createMemo(() => {
    const before = win().previous
    return before
      ? sum(group(props.data, filterOf(before, view().filters), 'status', undefined, minute()))
      : null
  })
  const groups = createMemo(() => group(props.data, filter(), view().by, view().split, minute()))
  const { sort, onSort } = useSort<BreakdownColumn>()
  const ordered = createMemo(() => orderGroups(groups(), sort(), view().by, view().split))
  const chart = createMemo(() => series(props.data, filter(), bucket(), view().by, TOP, minute()))
  const byTool = createMemo(() => tools(props.data, filter()))
  const leaks = createMemo(() => cache(props.data, filter()))
  const priciest = createMemo(() => turns(props.data, filter()))
  const filtered = createMemo(() => activeFilters(view().filters).length > 0)
  const ahead = createMemo(() =>
    forecast(daily(props.data, view().filters, minute()), minute(), filtered() ? {} : budget()),
  )
  const dayBudget = () => (filtered() ? undefined : budget().day)
  const perDay = createMemo(() => (dayBudget() ? daily(props.data, filter(), minute()) : []))

  const colors = createMemo(
    () =>
      new Map(
        chart()
          .stacks.filter((stack) => stack.key !== OTHER)
          .map((stack, i) => [stack.key, i]),
      ),
  )
  const repeatedTitles = createMemo(() => {
    const by = view().by
    if (by !== 'conversation' && by !== 'tree') return new Set<string>()
    const seen = new Set<string>()
    const repeated = new Set<string>()
    for (const stack of chart().stacks) {
      const title = label()(by, stack.key)
      if (seen.has(title)) repeated.add(title)
      seen.add(title)
    }
    return repeated
  })
  const chartLabel = (key: string) => {
    const title = label()(view().by, key)
    if (!repeatedTitles().has(title)) return title
    const conversation = conversations().get(Number(key))
    return `${title} ${conversation ? refOf(conversation) : `#${key}`}`
  }
  const drills = () => view().drills ?? []
  const addFilter = (dimension: Dimension, key: string) => {
    const current = view()
    const values = current.filters[dimension] ?? []
    const filters = {
      ...current.filters,
      [dimension]: values.includes(key) ? values : [...values, key],
    }
    if (dimension === current.by)
      update({
        filters,
        by: current.split ?? DRILL[current.by],
        split: undefined,
        drills: [...drills(), { dimension, by: current.by, split: current.split }],
      })
    else update({ filters })
  }
  const removeFilter = (dimension: Dimension) => {
    const { [dimension]: _, ...filters } = view().filters
    const at = drills().findIndex((drill) => drill.dimension === dimension)
    const back = drills()[at]
    update(
      back
        ? { filters, drills: drills().slice(0, at), by: back.by, split: back.split }
        : { filters },
    )
  }
  const clearFilters = () => {
    const first = drills()[0]
    update({ filters: {}, drills: [], ...(first ? { by: first.by, split: first.split } : {}) })
  }
  const handlers = createMemo<RowHandlers>(() => {
    const order = sort()
    return {
      conversations: conversations(),
      branching: branching(),
      colors: colors(),
      total: totals().usd,
      trend: win().days >= 3,
      onFilter: addFilter,
      order: (lines, dimension) => sorted(lines, order, columnsOf(dimension)),
    }
  })
  const chips = createMemo(() => activeFilters(view().filters))
  const nothing = () => totals().usd === 0 && groups().length === 0
  let cacheSection: HTMLDivElement | undefined

  return (
    <>
      <div
        class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border/70 px-3 py-1.5"
        data-spend-toolbar
      >
        <RangePicker now={minute()} onChange={update} view={view()} />
        <span class="hidden h-4 w-px bg-border @md:block" />
        <div class="flex min-w-0 flex-wrap items-center gap-1.5">
          <For each={chips()} keyed={([dimension]) => dimension}>
            {(chip) => (
              <Chip
                dimension={chip()[0]}
                onRemove={() => removeFilter(chip()[0])}
                values={chip()[1].map((key) => label()(chip()[0], key))}
              />
            )}
          </For>
          <AddFilter data={props.data} filter={filter()} label={label()} onAdd={addFilter} />
          <Show when={chips().length > 1}>
            <Button
              aria-label="Clear every filter"
              class={quiet}
              onClick={clearFilters}
              size={null}
              variant={null}
            >
              clear
            </Button>
          </Show>
        </div>
        <div class="ml-auto flex items-center gap-1">
          <BudgetButton budget={budget()} onChange={setBudget} />
        </div>
      </div>
      <div class="@container min-h-0 flex-1 overflow-y-auto" data-spend-surface>
        <div class={cn(page, 'gap-8 pt-5 pb-12')}>
          <Band
            ahead={ahead()}
            dayBudget={dayBudget()}
            filtered={filtered()}
            leakUsd={leaks().leakUsd}
            onLeaks={() => cacheSection?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            perDay={perDay()}
            previous={previous()}
            range={rangeLabel(win(), minute(), props.data.since)}
            since={props.data.since}
            totals={totals()}
            win={win()}
          />
          <Show
            when={!nothing()}
            fallback={
              <p class="py-10 text-center font-mono text-[11.5px] text-muted-foreground/80">
                nothing in this range matches {filtered() ? 'these filters' : ''}
                <Show when={filtered()}>
                  <Button
                    aria-label="Clear filters"
                    class="ml-2 h-auto font-mono text-[11.5px] font-normal text-foreground underline-offset-2 hover:underline"
                    onClick={clearFilters}
                    size={null}
                    variant={null}
                  >
                    clear filters
                  </Button>
                </Show>
              </p>
            }
          >
            <Section
              meta={`by ${DIMENSIONS[view().by].toLowerCase()}`}
              right={
                <Show when={allowed().length > 1}>
                  <SegmentedControl<Bucket>
                    aria-label="Bucket"
                    class="gap-0.5 border-0 p-0"
                    onValueChange={(option) => option && update({ bucket: option })}
                    value={bucket()}
                  >
                    <For each={allowed()}>
                      {(option) => (
                        <SegmentedControlItem
                          class={cn(segment, 'gap-0 px-2 text-[11px]')}
                          value={option}
                        >
                          {option}
                        </SegmentedControlItem>
                      )}
                    </For>
                  </SegmentedControl>
                </Show>
              }
              title={`Spend per ${bucket()}`}
            >
              <SpendChart
                bucket={bucket()}
                budget={bucket() === 'day' ? dayBudget() : undefined}
                label={chartLabel}
                now={minute()}
                onPick={(key) => addFilter(view().by, key)}
                stacks={chart().stacks}
                starts={chart().buckets}
              />
              <Show when={clipped() && props.data.since !== null}>
                <p class="pl-11 font-mono text-[10.5px] text-muted-foreground/70">
                  history starts {dateLabel(props.data.since!)} · {win().days} of the {full().days}{' '}
                  days recorded so far
                </p>
              </Show>
            </Section>
            <Section
              meta={
                <span class="flex items-center gap-0.5">
                  by
                  <DimensionPicker
                    label="Group by"
                    onChange={(by) =>
                      by &&
                      update({
                        by,
                        split: view().split === by ? undefined : view().split,
                        drills: undefined,
                      })
                    }
                    value={view().by}
                  />
                  then
                  <DimensionPicker
                    exclude={view().by}
                    label="Then by"
                    none="nothing"
                    onChange={(split) => update({ split, drills: undefined })}
                    value={view().split}
                  />
                </span>
              }
              right={
                <>
                  <span class="font-mono text-[11px] text-muted-foreground/70">
                    {groups().length} {groups().length === 1 ? 'group' : 'groups'}
                  </span>
                  <Button
                    aria-label="Download these groups as CSV"
                    class={quiet}
                    onClick={() =>
                      download(
                        `spend-${view().by}${view().split ? `-${view().split}` : ''}-${view().range}.csv`,
                        csv(ordered()),
                      )
                    }
                    size={null}
                    title="Download these groups as CSV"
                    variant={null}
                  >
                    <DownloadIcon class="size-3" />
                    csv
                  </Button>
                </>
              }
              title="Breakdown"
            >
              <Breakdown
                by={view().by}
                data={props.data}
                filter={filter()}
                firstLabel={DIMENSIONS[view().by].toLowerCase()}
                groups={ordered()}
                handlers={handlers()}
                onSort={onSort}
                sort={sort()}
                split={view().split}
              />
            </Section>
            <div
              class="flex scroll-mt-5 flex-col gap-8"
              data-spend-cache
              ref={(element) => {
                cacheSection = element
              }}
            >
              <Section
                meta="what a warm cache would have saved, and what keeping it warm would cost"
                title="Cache"
              >
                <CacheView
                  onFilter={(cls) => addFilter('cache', cls)}
                  report={leaks()}
                  total={totals().usd}
                />
              </Section>
              <Section
                meta="the responses that cost the most, and why; click one to open its conversation"
                title="Priciest turns"
              >
                <TurnList turns={priciest()} />
              </Section>
            </div>
            <Section
              meta={
                <span class="flex items-center gap-1.5">
                  <Estimate />
                  each response's real cost, split by how much of its prompt each tool's results
                  took
                </span>
              }
              title="Tools"
            >
              <ToolTable
                onFilter={(tool) => addFilter('tool', tool)}
                rows={byTool()}
                total={totals().usd}
              />
            </Section>
          </Show>
        </div>
      </div>
    </>
  )
}
