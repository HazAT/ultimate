/** @jsxImportSource @solidjs/web */
import { ListFilter } from '@lucide/solid'
import { createMemo, createSignal, For, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
import type { ConversationSummary } from '@/sdk'
import {
  cn,
  formatDuration,
  showSurface,
  switchConversation,
  useConversationSummary,
} from '@/sdk/solid'
import { AgentMark, AgentTitle, ConversationRef } from '../conversations/ui.solid.tsx'
import { stateTone, stateWord } from '../messages/ui.solid.tsx'
import type { ConversationState } from '../messages/ui.solid.tsx'
import { block, duration, label, ticks } from './layout.ts'
import type { TreeRow, WindowName } from './layout.ts'
import type { Lane, LaneRun } from './refs.ts'
import { clock, KindIcon, TraceTree } from './tree.solid.tsx'

export type LaneState = 'running' | Exclude<ConversationState, 'working'>
export const laneState = (lane: Lane, state: ConversationState, known: boolean): LaneState =>
  state === 'working' || (!known && lane.runs.length > 0 && lane.runs.at(-1)!.end === undefined)
    ? 'running'
    : state

export function standingName(lane: Lane, summary: ConversationSummary | undefined) {
  if (summary?.label === 'lander') return 'lander'
  if (lane.kind === 'standing' && lane.agent) return lane.agent
  if (summary?.label === 'agent' && summary.title?.startsWith('@')) return summary.title.slice(1)
  return undefined
}

const modelName = (model: string) => model.slice(model.indexOf('/') + 1)

export function Axis(props: { window: WindowName }) {
  return (
    <div class="relative h-5 font-mono text-[10px] text-muted-foreground/70 tabular-nums">
      <For each={ticks(props.window)} keyed={(tick) => tick.label}>
        {(tick) => (
          <span
            class={cn(
              'absolute top-1 -translate-x-1/2',
              tick().at === 1 && 'translate-x-[-100%] rounded-sm bg-brand/15 px-1 text-brand',
            )}
            style={{ left: `${tick().at * 100}%` }}
          >
            {tick().label}
          </span>
        )}
      </For>
    </div>
  )
}

function Grid(props: { window: WindowName }) {
  return (
    <For each={ticks(props.window)} keyed={(tick) => tick.label}>
      {(tick) => (
        <span
          aria-hidden="true"
          class={cn('absolute inset-y-0 w-px', tick().at === 1 ? 'bg-brand/40' : 'bg-border/50')}
          style={{ left: `calc(${tick().at * 100}% - ${tick().at === 1 ? 1 : 0}px)` }}
        />
      )}
    </For>
  )
}

function Block(props: {
  run: LaneRun
  since: number
  now: number
  tone: 'running' | 'waiting' | 'done'
  selected: boolean
  name: string
  onSelect: () => void
}) {
  const run = () => props.run
  const placement = createMemo(() => block(run(), props.since, props.now))
  const start = () => Date.parse(run().start)
  const end = () => (run().end === undefined ? props.now : Date.parse(run().end!))
  const failed = createMemo(() => run().calls.filter((call) => !call.ok).length)
  const calls = () => run().calls.length + (run().more ?? 0)
  return (
    <Show when={placement()}>
      {(place) => (
        <Tooltip>
          <TooltipTrigger
            aria-label={props.name}
            aria-pressed={props.selected ? 'true' : 'false'}
            data-run={run().start}
            class={cn(
              '@container absolute inset-y-1 min-w-[3px] overflow-hidden rounded-[4px] text-left ring-1 outline-none ring-inset focus-visible:ring-ring',
              props.tone === 'running' && 'border-r-2 border-brand bg-brand/20 ring-brand/30',
              props.tone === 'waiting' && 'bg-amber-400/20 ring-amber-400/40',
              props.tone === 'done' &&
                'bg-muted-foreground/15 ring-border hover:bg-muted-foreground/25',
              props.selected && 'ring-foreground/50',
            )}
            onClick={() => props.onSelect()}
            style={{ left: `${place().left * 100}%`, width: `${place().width * 100}%` }}
          >
            <For each={run().calls} keyed={(call) => call.trace}>
              {(call) => (
                <span
                  aria-hidden="true"
                  class={cn(
                    'absolute bottom-0 h-1.5 w-px',
                    call().ok ? 'bg-foreground/25' : 'h-full w-0.5 bg-error',
                  )}
                  style={{
                    left: `${(end() > start() ? (Date.parse(call().at) - start()) / (end() - start()) : 0) * 100}%`,
                  }}
                />
              )}
            </For>
            <span
              class={cn(
                'relative hidden truncate px-1.5 font-mono text-[10px] leading-[20px] @[2.75rem]:block',
                props.tone === 'running' ? 'text-brand' : 'text-foreground/70',
              )}
            >
              {label(run().calls, run().more)}
            </span>
          </TooltipTrigger>
          <TooltipContent class="font-mono text-[11px]" side="top">
            {calls()} {calls() === 1 ? 'call' : 'calls'} ·{' '}
            {formatDuration(duration(run(), props.now))}
            {run().end === undefined && ' · running'}
            {failed() > 0 && ` · ${failed()} failed`}
          </TooltipContent>
        </Tooltip>
      )}
    </Show>
  )
}

function Calls(props: { run: LaneRun; conversation: number }) {
  const [open, setOpen] = createSignal<number>()
  return (
    <ul class="my-1 max-h-72 overflow-y-auto rounded-md border border-border/70 bg-muted/20 py-1 font-mono text-[10.5px] leading-[18px] text-muted-foreground">
      <For each={props.run.calls} keyed={false}>
        {(call, index) => (
          <li>
            <Button
              aria-label={`Inspect call ${index + 1} in #${props.conversation}: ${call().name}`}
              aria-expanded={open() === index ? 'true' : 'false'}
              class="flex w-full min-w-0 items-start justify-start gap-1.5 px-2 py-px text-left text-[length:inherit] leading-[inherit] font-normal hover:bg-muted/50"
              onClick={() => setOpen((previous) => (previous === index ? undefined : index))}
              size={null}
              variant={null}
            >
              <span class="w-14 shrink-0 tabular-nums text-muted-foreground/60">
                {clock(call().at)}
              </span>
              <KindIcon kind={call().kind} ok={call().ok} />
              <span
                class={cn(
                  'min-w-0 flex-1 truncate',
                  call().ok ? 'text-foreground/85' : 'text-error',
                )}
              >
                {call().name}
              </span>
              <span class="shrink-0 tabular-nums">{formatDuration(call().ms)}</span>
            </Button>
            <Show when={open() === index && call().trace} keyed>
              {(trace) => <TraceTree trace={trace} />}
            </Show>
          </li>
        )}
      </For>
      <Show when={props.run.more !== undefined}>
        <li class="px-2 text-muted-foreground/60">+{props.run.more} newer calls not shown</li>
      </Show>
    </ul>
  )
}

export const TREE_LEVEL_INDENT_PX = 14
export const LANE_HEAD_CENTRE_Y_PX = 24
const dotted = 'absolute border-dotted border-muted-foreground/35'
const indent = (depth: number) => `${depth * TREE_LEVEL_INDENT_PX}px`
const x = (level: number) => `${(level - 0.5) * TREE_LEVEL_INDENT_PX}px`

export function Guide(props: {
  row: Pick<TreeRow, 'depth' | 'last' | 'through'>
  centre?: number
}) {
  const centre = () => `${props.centre ?? LANE_HEAD_CENTRE_Y_PX}px`
  return (
    <Show when={props.row.depth > 0}>
      <span aria-hidden="true" class="pointer-events-none">
        <For each={props.row.through} keyed={false}>
          {(on, index) => (
            <Show when={on()}>
              <span class={cn(dotted, 'inset-y-0 border-l')} style={{ left: x(index + 1) }} />
            </Show>
          )}
        </For>
        <span
          class={cn(dotted, 'top-0 rounded-bl-[5px] border-b border-l')}
          style={{
            left: x(props.row.depth),
            height: centre(),
            width: `${TREE_LEVEL_INDENT_PX / 2 + 2}px`,
          }}
        />
        <Show when={!props.row.last}>
          <span
            class={cn(dotted, 'bottom-0 border-l')}
            style={{ left: x(props.row.depth), top: centre() }}
          />
        </Show>
      </span>
    </Show>
  )
}

const laneWord = (state: LaneState, waitLabel?: string) =>
  state === 'running' ? 'running' : stateWord(state, 0, waitLabel)
const laneTone = (state: LaneState) => stateTone[state === 'running' ? 'working' : state]

export function LaneRow(props: {
  row: Extract<TreeRow, { kind: 'lane' }>
  state: LaneState
  waitLabel?: string
  window: WindowName
  since: number
  now: number
  dimmed: boolean
  onFilter: () => void
  onHover: (hovered: boolean) => void
  onPick: (picked: boolean) => void
}) {
  const lane = () => props.row.lane
  const id = () => lane().conversation
  const summary = useConversationSummary(id)
  const standing = createMemo(() => standingName(lane(), summary()))
  const [selected, setSelected] = createSignal<string>()
  const run = createMemo(() => lane().runs.find((item) => item.start === selected()))
  const open = () => {
    showSurface('agent')
    switchConversation(id())
  }
  return (
    <li
      class={cn(
        'relative border-b border-border/50 pl-(--indent) transition-opacity last:border-b-0 md:pl-0',
        props.dimmed && 'opacity-40',
      )}
      data-depth={props.row.depth}
      data-lane={id()}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') props.onHover(true)
      }}
      onPointerLeave={() => props.onHover(false)}
      style={{ '--indent': indent(props.row.depth) }}
    >
      <Guide row={props.row} />
      <div class="flex flex-col gap-1 py-1.5 md:flex-row md:items-center md:gap-3">
        <div class="group flex min-w-0 items-center gap-2 md:w-56 md:shrink-0 md:pl-(--indent)">
          <Button
            aria-label={`Open lane conversation #${id()}`}
            class="flex min-w-0 flex-1 justify-start gap-2 rounded-md text-left font-normal outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={open}
            title={`Open #${id()}`}
            size={null}
            variant={null}
          >
            <AgentMark
              name={standing() ?? lane().agent ?? 'agent'}
              presence={
                props.state === 'running'
                  ? 'working'
                  : props.state === 'waits'
                    ? 'waiting'
                    : props.state === 'awaiting'
                      ? 'awaiting'
                      : 'idle'
              }
            />
            <span class="flex min-w-0 flex-1 flex-col">
              <Show
                when={standing()}
                fallback={
                  <ConversationRef class="text-[12.5px] leading-5 text-foreground" id={id()} />
                }
              >
                {(name) => (
                  <span class="truncate text-[12.5px] leading-5 font-semibold text-foreground">
                    <AgentTitle name={name()} />{' '}
                    <span class="ml-1.5 font-mono text-[10px] font-normal text-muted-foreground/70">
                      #{id()}
                    </span>
                  </span>
                )}
              </Show>
              <span class="flex min-w-0 items-center gap-1.5 font-mono text-[10px] leading-4 text-muted-foreground">
                <span
                  class={cn('max-w-full shrink-0 truncate', laneTone(props.state))}
                  title={props.waitLabel}
                >
                  {laneWord(props.state, props.waitLabel)}
                </span>
                <Show when={!standing() && lane().agent}>
                  <span class="min-w-0 truncate">
                    · {lane().kind === 'branch' ? 'branch · coordinator' : lane().agent}
                  </span>
                </Show>
                <Show when={lane().model}>
                  {(model) => <span class="min-w-0 truncate">· {modelName(model())}</span>}
                </Show>
              </span>
            </span>
          </Button>
          <Button
            aria-label={`Show only #${id()} in the stream`}
            size={null}
            variant={null}
            class="shrink-0 rounded-sm p-1 text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 pointer-coarse:opacity-100"
            onClick={() => props.onFilter()}
            title="Show only this conversation in the stream"
          >
            <ListFilter class="size-3" />
          </Button>
        </div>
        <div class="relative h-7 min-w-0 md:flex-1" data-timeline>
          <Grid window={props.window} />
          <For each={lane().runs} keyed={(item) => item.start}>
            {(item, index) => (
              <Block
                now={props.now}
                name={`Inspect run ${item().start} in #${id()}`}
                onSelect={() => {
                  const start = item().start
                  const pick = selected() !== start
                  setSelected(pick ? start : undefined)
                  props.onPick(pick)
                }}
                run={item()}
                selected={item().start === selected()}
                since={props.since}
                tone={
                  item().end === undefined
                    ? 'running'
                    : props.state === 'waits' && index() === lane().runs.length - 1
                      ? 'waiting'
                      : 'done'
                }
              />
            )}
          </For>
        </div>
      </div>
      <Show when={run()}>
        {(shown) => (
          <div class="pb-2 md:pl-[15.75rem]">
            <Calls conversation={id()} run={shown()} />
          </div>
        )}
      </Show>
    </li>
  )
}
