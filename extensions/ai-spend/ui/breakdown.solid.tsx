import { ArrowUpRightIcon, ChevronRightIcon, ListFilterIcon } from '@lucide/solid'
import { For, Show, createMemo, createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { cn, showSurface, switchConversation } from '@/sdk/solid'
import { bandOrder } from '../model/dimensions.ts'
import type { Dimension, Filter } from '../model/dimensions.ts'
import { count, keyLabel, percent, usd } from '../model/format.ts'
import { group } from '../model/groups.ts'
import type { Group } from '../model/groups.ts'
import { refOf } from '../model/types.ts'
import type { Conversation, SpendData } from '../model/types.ts'
import { swatchOf } from './chart.solid.tsx'
import { SortHead, sorted } from './sort.solid.tsx'
import type { Columns, Sort } from './sort.solid.tsx'

const FIRST = 25

export const GRID =
  'grid grid-cols-[minmax(0,1fr)_4.75rem_6.5rem] items-center gap-x-3 @2xl:grid-cols-[minmax(0,1fr)_4.75rem_6.5rem_4rem_4rem] @4xl:grid-cols-[minmax(0,1fr)_5rem_7rem_4.5rem_4.5rem_4.5rem]'

export type RowHandlers = {
  conversations: Map<number, Conversation>
  branching: Set<number>
  colors: Map<string, number>
  total: number
  trend: boolean
  onFilter: (dimension: Dimension, key: string) => void
  order: <T extends Line>(lines: T[], dimension: Dimension) => T[]
}

export type BreakdownColumn = 'name' | 'spend' | 'tokens' | 'responses'
export type BreakdownSort = Sort<BreakdownColumn>

const nameOf = (dimension: Dimension) => (line: Line) => {
  if (dimension === 'prompt') return bandOrder(line.key)
  return dimension === 'hour' || dimension === 'day' || dimension === 'week'
    ? line.key
    : keyLabel(dimension, line.key, line.label)
}
export const columnsOf = (dimension: Dimension): Columns<BreakdownColumn, Line> => ({
  name: { value: nameOf(dimension) },
  spend: { value: (line) => line.usd },
  tokens: { value: (line) => line.tokens },
  responses: { value: (line) => line.responses },
})

export function orderGroups(
  groups: Group[],
  sort: BreakdownSort,
  by: Dimension,
  split?: Dimension,
): Group[] {
  if (!sort) return groups
  return sorted(groups, sort, columnsOf(by)).map((g) =>
    g.children && split ? { ...g, children: sorted(g.children, sort, columnsOf(split)) } : g,
  )
}

function HeadRow(props: {
  first: string
  trend: boolean
  sort: BreakdownSort
  onSort: (column: BreakdownColumn, text?: boolean) => void
}) {
  return (
    <div
      class={cn(
        GRID,
        'h-7 border-b border-border/60 px-2 font-mono text-[10.5px] text-muted-foreground/70',
      )}
    >
      <SortHead
        class="pl-9"
        column="name"
        onSort={props.onSort}
        sort={props.sort}
        table="breakdown"
        text
      >
        {props.first}
      </SortHead>
      <SortHead column="spend" onSort={props.onSort} right sort={props.sort} table="breakdown">
        spend
      </SortHead>
      <span class="text-right">share</span>
      <SortHead
        class="hidden @2xl:block"
        column="tokens"
        onSort={props.onSort}
        right
        sort={props.sort}
        table="breakdown"
      >
        tokens
      </SortHead>
      <SortHead
        class="hidden @2xl:block"
        column="responses"
        onSort={props.onSort}
        right
        sort={props.sort}
        table="breakdown"
        title="Model responses; overhead rows are not responses"
      >
        responses
      </SortHead>
      <span class={cn('hidden text-right', props.trend && '@4xl:block')}>per day</span>
    </div>
  )
}

function Sparkline(props: { values: number[] }) {
  const w = 64
  const h = 16
  const shape = createMemo(() => {
    const max = Math.max(0, ...props.values)
    if (props.values.length < 2 || max <= 0) return undefined
    const points = props.values
      .map(
        (value, i) =>
          `${((i / (props.values.length - 1)) * w).toFixed(1)},${(h - 1 - (value / max) * (h - 2)).toFixed(1)}`,
      )
      .join(' ')
    return { points, area: `0,${h} ${points} ${w},${h}` }
  })
  return (
    <Show when={shape()} fallback={<span class="block h-4" />}>
      {(drawn) => (
        <svg aria-hidden="true" class="ml-auto block overflow-visible" height={h} width={w}>
          <polygon class="fill-muted-foreground/10" points={drawn().area} />
          <polyline
            class="fill-none stroke-muted-foreground/70"
            points={drawn().points}
            stroke-linejoin="round"
            stroke-width={1}
          />
        </svg>
      )}
    </Show>
  )
}

export function ShareBar(props: { share: number; class?: string }) {
  return (
    <span class={cn('h-1 w-10 overflow-hidden rounded-full bg-muted', props.class)}>
      <span
        class="block h-full rounded-full bg-foreground/35"
        style={{ width: `${Math.min(100, props.share * 100)}%` }}
      />
    </span>
  )
}

function ShareCell(props: { share: number }) {
  return (
    <span class="flex items-center justify-end gap-2">
      <ShareBar share={props.share} />
      <span class="w-11 text-right">{percent(props.share)}</span>
    </span>
  )
}

type Line = {
  key: string
  label: string
  usd: number
  tokens: number
  responses: number
  daily: number[]
  own?: number
}

function Meta(props: { conversation: Conversation }) {
  return (
    <span class="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground/70">
      <Show when={props.conversation.busy}>
        <span class="size-1.5 animate-pulse-dot rounded-full bg-brand" title="working" />
      </Show>
      {refOf(props.conversation)}
      <Show when={props.conversation.title !== `@${props.conversation.agent}`}>
        <span class="hidden max-w-28 truncate @3xl:inline">{props.conversation.agent}</span>
      </Show>
    </span>
  )
}

export function openConversation(conversation: Conversation) {
  showSurface('agent')
  switchConversation(conversation.id as Parameters<typeof switchConversation>[0])
}

function Row(props: {
  line: Line
  dimension: Dimension
  depth: number
  within?: string
  swatch?: number
  open?: boolean
  onToggle?: () => void
  handlers: RowHandlers
}) {
  const conversation = createMemo(() =>
    props.dimension === 'conversation' || props.dimension === 'tree'
      ? props.handlers.conversations.get(Number(props.line.key))
      : undefined,
  )
  const name = createMemo(() => keyLabel(props.dimension, props.line.key, props.line.label))
  const where = () => {
    const found = conversation()
    return `${props.dimension} ${name()}${found ? ` ${refOf(found)}` : ''}${props.within ? ` under ${props.within}` : ''}`
  }
  return (
    <div
      class={cn(
        GRID,
        'group/row h-8 rounded-md px-2 font-mono text-[11.5px] text-foreground/85 tabular-nums hover:bg-muted/40',
        props.open && 'bg-muted/25',
      )}
      data-spend-row={`${props.dimension}:${props.line.key}`}
    >
      <span
        class="flex min-w-0 items-center gap-1.5"
        style={{ 'padding-left': `${props.depth * 18}px` }}
      >
        <Show when={props.onToggle} fallback={<span class="size-4 shrink-0" />}>
          {(toggle) => (
            <Button
              aria-expanded={props.open ? 'true' : 'false'}
              aria-label={`${props.open ? 'Collapse' : 'Expand'} ${where()}`}
              class="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => toggle()()}
              size={null}
              variant={null}
            >
              <ChevronRightIcon
                class={cn('size-3 transition-transform', props.open && 'rotate-90')}
              />
            </Button>
          )}
        </Show>
        <Show
          when={props.swatch !== undefined}
          fallback={
            <Show when={props.depth === 0}>
              <span class="size-2 shrink-0" />
            </Show>
          }
        >
          <span
            class={cn('size-2 shrink-0 rounded-[2px]', swatchOf(props.line.key, props.swatch!).bg)}
          />
        </Show>
        <Button
          aria-label={`Filter to ${where()}`}
          class="flex h-auto min-w-0 shrink items-center justify-start gap-2 text-[length:inherit] rounded-sm text-left font-normal outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => props.handlers.onFilter(props.dimension, props.line.key)}
          size={null}
          title={`${name()}${conversation() ? ` · ${conversation()!.agent}` : ''}\nClick to filter to it`}
          variant={null}
        >
          <span class="min-w-0 truncate font-sans text-[13px] text-foreground/90 group-hover/row:text-foreground">
            {name()}
          </span>
          <Show when={conversation()}>{(found) => <Meta conversation={found()} />}</Show>
          <ListFilterIcon class="size-3 shrink-0 text-muted-foreground opacity-0 group-hover/row:opacity-100" />
        </Button>
        <Show when={conversation()}>
          {(found) => (
            <Button
              aria-label={`Open ${where()}`}
              class="ml-auto flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-none group-hover/row:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-0 data-disabled:opacity-0 pointer-coarse:opacity-100"
              disabled={!found().live}
              onClick={() => openConversation(found())}
              size={null}
              title={
                found().live
                  ? `Open #${found().id}`
                  : 'In an earlier chapter: only its costs are kept'
              }
              variant={null}
            >
              <ArrowUpRightIcon class="size-3.5" />
            </Button>
          )}
        </Show>
      </span>
      <span
        class="text-right text-foreground"
        title={
          props.line.own !== undefined
            ? `${usd(props.line.own)} itself, the rest under it`
            : undefined
        }
      >
        {usd(props.line.usd)}
      </span>
      <ShareCell share={props.handlers.total > 0 ? props.line.usd / props.handlers.total : 0} />
      <span class="hidden text-right text-muted-foreground @2xl:block">
        {count(props.line.tokens)}
      </span>
      <span class="hidden text-right text-muted-foreground @2xl:block">
        {props.line.responses ? count(props.line.responses) : '—'}
      </span>
      <span class={cn('hidden', props.handlers.trend && '@4xl:block')}>
        <Sparkline values={props.line.daily} />
      </span>
    </div>
  )
}

type Node = Line & { children: Node[] }

function hierarchy(groups: Group[], conversations: Map<number, Conversation>): Node[] {
  const nodes = new Map<number, Node>(
    groups.map((g) => [Number(g.key), { ...g, own: g.usd, daily: [...g.daily], children: [] }]),
  )
  const roots: Node[] = []
  for (const [id, node] of nodes) {
    let up = conversations.get(id)
    let parent: Node | undefined
    const seen = new Set([id])
    while (up && !parent) {
      const next = up.owner ?? up.parent
      if (next === undefined || seen.has(next)) break
      seen.add(next)
      parent = nodes.get(next)
      up = conversations.get(next)
    }
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const roll = (node: Node): Node => {
    for (const child of node.children.map(roll)) {
      node.usd += child.usd
      node.tokens += child.tokens
      node.responses += child.responses
      child.daily.forEach((value, i) => (node.daily[i] = (node.daily[i] ?? 0) + value))
    }
    node.children = node.children.toSorted((a, b) => b.usd - a.usd)
    return node
  }
  return roots.map(roll).toSorted((a, b) => b.usd - a.usd)
}

function NodeRows(props: { node: Node; depth: number; within: string; handlers: RowHandlers }) {
  const [open, setOpen] = createSignal(false)
  const branches = () => props.node.children.length > 0
  return (
    <>
      <Row
        depth={props.depth}
        dimension="conversation"
        handlers={props.handlers}
        line={branches() ? props.node : { ...props.node, own: undefined }}
        onToggle={branches() ? () => setOpen(!open()) : undefined}
        open={open()}
        within={props.within}
      />
      <Show when={open()}>
        <For
          each={props.handlers.order(props.node.children, 'conversation')}
          keyed={(child) => child.key}
        >
          {(child) => (
            <NodeRows
              depth={props.depth + 1}
              handlers={props.handlers}
              node={child()}
              within={props.within}
            />
          )}
        </For>
      </Show>
    </>
  )
}

function TreeRows(props: {
  data: SpendData
  filter: Filter
  root: string
  within: string
  handlers: RowHandlers
}) {
  const top = createMemo(() => {
    const nodes = hierarchy(
      group(props.data, { ...props.filter, tree: [props.root] }, 'conversation'),
      props.handlers.conversations,
    )
    return nodes.length === 1 && nodes[0].key === props.root ? nodes[0].children : nodes
  })
  return (
    <For each={props.handlers.order(top(), 'conversation')} keyed={(node) => node.key}>
      {(node) => (
        <NodeRows depth={1} handlers={props.handlers} node={node()} within={props.within} />
      )}
    </For>
  )
}

function GroupRows(props: {
  g: Group
  by: Dimension
  split?: Dimension
  data: SpendData
  filter: Filter
  handlers: RowHandlers
  initiallyOpen: boolean
}) {
  const [open, setOpen] = createSignal(props.initiallyOpen)
  const subtree = () => props.by === 'tree' && !props.split
  const expandable = () =>
    subtree()
      ? props.handlers.branching.has(Number(props.g.key))
      : (props.g.children?.length ?? 0) > 0
  const name = () => `${props.by} ${keyLabel(props.by, props.g.key, props.g.label)}`
  return (
    <>
      <Row
        depth={0}
        dimension={props.by}
        handlers={props.handlers}
        line={props.g}
        onToggle={expandable() ? () => setOpen(!open()) : undefined}
        open={open()}
        swatch={props.handlers.colors.get(props.g.key)}
      />
      <Show when={open()}>
        <Show
          when={subtree()}
          fallback={
            <For each={props.g.children ?? []} keyed={(child) => child.key}>
              {(child) => (
                <Row
                  depth={1}
                  dimension={props.split!}
                  handlers={props.handlers}
                  line={child()}
                  within={name()}
                />
              )}
            </For>
          }
        >
          <TreeRows
            data={props.data}
            filter={props.filter}
            handlers={props.handlers}
            root={props.g.key}
            within={name()}
          />
        </Show>
      </Show>
    </>
  )
}

export function Breakdown(props: {
  groups: Group[]
  by: Dimension
  split?: Dimension
  data: SpendData
  filter: Filter
  handlers: RowHandlers
  firstLabel: string
  sort: BreakdownSort
  onSort: (column: BreakdownColumn, text?: boolean) => void
}) {
  const [all, setAll] = createSignal(false)
  const shown = () => (all() ? props.groups : props.groups.slice(0, FIRST))
  return (
    <div class="flex flex-col">
      <HeadRow
        first={props.firstLabel}
        onSort={props.onSort}
        sort={props.sort}
        trend={props.handlers.trend}
      />
      <div class="flex flex-col pt-1">
        <For each={shown()} keyed={(g) => `${props.by}:${props.split ?? ''}:${g.key}`}>
          {(g, i) => (
            <GroupRows
              by={props.by}
              data={props.data}
              filter={props.filter}
              g={g()}
              handlers={props.handlers}
              initiallyOpen={
                i() === 0 &&
                props.by === 'tree' &&
                !props.split &&
                props.handlers.total > 0 &&
                g().usd / props.handlers.total > 0.5
              }
              split={props.split}
            />
          )}
        </For>
      </div>
      <Show when={props.groups.length > FIRST}>
        <Button
          aria-label={all() ? 'Show the first 25 groups' : `Show all ${props.groups.length} groups`}
          class="mt-1 h-7 self-start rounded-md px-2 pl-9 font-mono text-[11px] font-normal text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => setAll(!all())}
          size={null}
          variant={null}
        >
          {all() ? 'show the first 25' : `show all ${props.groups.length}`}
        </Button>
      </Show>
    </div>
  )
}
