import { ListFilterIcon } from 'lucide-react'
import { useState } from 'react'
import type { CSSProperties } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn, formatDuration, useConversations, useUltimate } from '@/sdk'
import type { ConversationSummary } from '@/sdk'
import { stateTone, stateWord } from '../messages/ui.tsx'
import type { ConversationState } from '../messages/ui.tsx'
import { AgentMark, agentTitle, ConversationRef } from '../conversations/ui.tsx'
import { block, duration, label, ticks } from './layout.ts'
import type { TreeRow, WindowName } from './layout.ts'
import type { Lane, LaneRun } from './refs.ts'
import { clock, KindIcon, TraceTree } from './tree.tsx'

/**
 * Where a lane stands: its conversation's state, the one the sidebar shows; `known` is false while the conversation has
 * no overview row yet, when only an open run on the timeline says it runs.
 */
export type LaneState = 'running' | Exclude<ConversationState, 'working'>
export const laneState = (lane: Lane, state: ConversationState, known: boolean): LaneState =>
  state === 'working' || (!known && lane.runs.length > 0 && lane.runs.at(-1)!.end === undefined)
    ? 'running'
    : state

/** A standing agent's name (`ultimate`, `lander`) for its mark and title; undefined for other conversations. */
export function standingName(lane: Lane, summary: ConversationSummary | undefined) {
  if (summary?.label === 'lander') return 'lander'
  if (lane.kind === 'standing' && lane.agent) return lane.agent
  if (summary?.label === 'agent' && summary.title?.startsWith('@')) return summary.title.slice(1)
  return undefined
}

/** `openai/gpt-5.1-codex` → `gpt-5.1-codex`: the model as the composer names it. */
const modelName = (model: string) => model.slice(model.indexOf('/') + 1)

/** The window's time axis: faint grid lines at each tick, labelled underneath, `now` at the right edge. */
export function Axis({ window }: { window: WindowName }) {
  return (
    <div className="relative h-5 font-mono text-[0.625rem] text-muted-foreground tabular-nums">
      {ticks(window).map((tick) => (
        <span
          className={cn(
            'absolute top-1 -translate-x-1/2',
            tick.at === 1 && 'translate-x-[-100%] rounded-sm bg-brand/15 px-1 text-brand',
          )}
          key={tick.label}
          style={{ left: `${tick.at * 100}%` }}
        >
          {tick.label}
        </span>
      ))}
    </div>
  )
}

/** The vertical grid lines behind a lane's timeline. */
function Grid({ window }: { window: WindowName }) {
  return (
    <>
      {ticks(window).map((tick) => (
        <span
          aria-hidden
          className={cn('absolute inset-y-0 w-px', tick.at === 1 ? 'bg-brand/40' : 'bg-border/50')}
          key={tick.label}
          style={{ left: `calc(${tick.at * 100}% - ${tick.at === 1 ? 1 : 0}px)` }}
        />
      ))}
    </>
  )
}

/** One run as a rounded block: accent while open, amber when its lane waits on you, else muted; calls as ticks. */
function Block({
  run,
  since,
  now,
  tone,
  selected,
  onSelect,
}: {
  run: LaneRun
  since: number
  now: number
  tone: 'running' | 'waiting' | 'done'
  selected: boolean
  onSelect: () => void
}) {
  const place = block(run, since, now)
  if (!place) return null
  const start = Date.parse(run.start)
  const end = run.end === undefined ? now : Date.parse(run.end)
  const failed = run.calls.filter((call) => !call.ok).length
  const calls = run.calls.length + (run.more ?? 0)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={cn(
            '@container absolute inset-y-1 min-w-[3px] cursor-pointer overflow-hidden rounded-[4px] text-left ring-1 outline-none ring-inset focus-visible:ring-ring',
            tone === 'running' && 'border-r-2 border-brand bg-brand/20 ring-brand/30',
            tone === 'waiting' && 'bg-amber-400/20 ring-amber-400/40',
            tone === 'done' && 'bg-muted-foreground/15 ring-border hover:bg-muted-foreground/25',
            selected && 'ring-foreground/50',
          )}
          data-run={run.start}
          onClick={onSelect}
          style={{ left: `${place.left * 100}%`, width: `${place.width * 100}%` }}
          type="button"
        >
          {run.calls.map((call, index) => (
            <span
              aria-hidden
              className={cn(
                'absolute bottom-0 h-1.5 w-px',
                call.ok ? 'bg-foreground/25' : 'h-full w-0.5 bg-error',
              )}
              // oxlint-disable-next-line react/no-array-index-key -- Run calls have no per-call id; traces can repeat.
              key={index}
              style={{
                left: `${(end > start ? (Date.parse(call.at) - start) / (end - start) : 0) * 100}%`,
              }}
            />
          ))}
          <span
            className={cn(
              // A label shows only where the block has room for a few letters of it.
              'relative hidden truncate px-1.5 font-mono text-[0.625rem] leading-[1.25rem] @[2.75rem]:block',
              tone === 'running' ? 'text-brand' : 'text-foreground/70',
            )}
          >
            {label(run.calls, run.more)}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="font-mono text-[0.6875rem]" side="top">
        {calls} {calls === 1 ? 'call' : 'calls'} · {formatDuration(duration(run, now))}
        {run.end === undefined && ' · running'}
        {failed > 0 && ` · ${failed} failed`}
      </TooltipContent>
    </Tooltip>
  )
}

/** The calls of one run, one line each; a click opens a call's trace tree beneath it. */
function Calls({ run }: { run: LaneRun }) {
  const [open, setOpen] = useState<number>()
  return (
    <ul className="my-1 max-h-72 overflow-y-auto rounded-md border border-border/70 bg-muted/20 py-1 font-mono text-[0.6562rem] leading-[1.125rem] text-muted-foreground">
      {run.calls.map((call, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- Run calls have no per-call id; traces can repeat.
        <li key={index}>
          <button
            className="flex w-full min-w-0 cursor-pointer items-start gap-1.5 px-2 py-px text-left hover:bg-muted/50"
            onClick={() => setOpen(open === index ? undefined : index)}
            type="button"
          >
            <span className="w-14 shrink-0 tabular-nums text-muted-foreground">
              {clock(call.at)}
            </span>
            <KindIcon kind={call.kind} ok={call.ok} />
            <span
              className={cn(
                'min-w-0 flex-1 truncate',
                call.ok ? 'text-foreground/85' : 'text-error',
              )}
            >
              {call.name}
            </span>
            <span className="shrink-0 tabular-nums">{formatDuration(call.ms)}</span>
          </button>
          {open === index && <TraceTree trace={call.trace} />}
        </li>
      ))}
      {run.more !== undefined && (
        <li className="px-2 text-muted-foreground">+{run.more} newer calls not shown</li>
      )}
    </ul>
  )
}

/** Indentation per tree level, in pixels; the guide of level `i` runs down the middle of its column. */
export const INDENT = 14
/** Where a lane's head row is centred, from the top of its row: the elbow meets it, links start and end there. */
export const ROW_CENTRE = 24

const dotted = 'absolute border-dotted border-muted-foreground/35'

/**
 * The tree guide in front of a row: a dotted line down each ancestor column that has more rows below, and an elbow from
 * the parent's column into the row (running on down unless the row is its parent's last).
 */
export function Guide({
  row,
  centre = ROW_CENTRE,
}: {
  row: Pick<TreeRow, 'depth' | 'last' | 'through'>
  centre?: number
}) {
  if (row.depth === 0) return null
  const x = (level: number) => (level - 1) * INDENT + INDENT / 2
  return (
    <span aria-hidden className="pointer-events-none">
      {row.through.map(
        (on, index) =>
          on && (
            <span
              className={cn(dotted, 'inset-y-0 border-l')}
              // oxlint-disable-next-line react/no-array-index-key -- Guide columns are addressed by tree depth.
              key={index}
              style={{ left: x(index + 1) }}
            />
          ),
      )}
      <span
        className={cn(dotted, 'top-0 rounded-bl-[5px] border-b border-l')}
        style={{
          left: x(row.depth),
          height: centre,
          width: INDENT / 2 + 2,
        }}
      />
      {!row.last && (
        <span
          className={cn(dotted, 'bottom-0 border-l')}
          style={{ left: x(row.depth), top: centre }}
        />
      )}
    </span>
  )
}

/** A lane says its conversation's state in the sidebar's words; only an open run says "running". */
const laneWord = (state: LaneState) => (state === 'running' ? 'running' : stateWord(state))
const laneTone = (state: LaneState) => stateTone[state === 'running' ? 'working' : state]

/**
 * One agent's lane: who it is (its mark and name, its model, its state) on the left, its runs on the timeline on the
 * right; on a phone the name sits above a full-width timeline. A click on the name opens the conversation.
 */
export function LaneRow({
  row,
  state,
  window,
  since,
  now,
  dimmed,
  onFilter,
  onHover,
  onPick,
}: {
  row: Extract<TreeRow, { kind: 'lane' }>
  state: LaneState
  window: WindowName
  since: number
  now: number
  /** Outside the hovered or picked lane's chain. */
  dimmed: boolean
  onFilter: () => void
  onHover: (hovered: boolean) => void
  /** A run was opened (true) or closed (false): the lane stays highlighted while one is open. */
  onPick: (picked: boolean) => void
}) {
  const { lane } = row
  const actions = useUltimate()
  const summary = useConversations().find((item) => item.id === lane.conversation)
  const standing = standingName(lane, summary)
  const [selected, setSelected] = useState<string>()
  const run = lane.runs.find((item) => item.start === selected)
  const open = () => {
    actions.showSurface('agent')
    actions.switchConversation(lane.conversation)
  }
  return (
    <li
      className={cn(
        'relative border-b border-border/50 pl-(--indent) transition-opacity last:border-b-0 md:pl-0',
        dimmed && 'opacity-40',
      )}
      data-depth={row.depth}
      data-lane={lane.conversation}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{ '--indent': `${row.depth * INDENT}px` } as CSSProperties}
    >
      <Guide row={row} />
      <div className="flex flex-col gap-1 py-1.5 md:flex-row md:items-center md:gap-3">
        <div className="group flex min-w-0 items-center gap-2 md:w-56 md:shrink-0 md:pl-(--indent)">
          <button
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={open}
            title={`Open #${lane.conversation}`}
            type="button"
          >
            <AgentMark
              name={standing ?? lane.agent ?? 'agent'}
              presence={state === 'running' ? 'working' : state === 'waits' ? 'waiting' : 'idle'}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              {standing ? (
                <span className="truncate text-[0.7812rem] leading-5 font-semibold text-foreground">
                  {agentTitle(standing)}
                  <span className="ml-1.5 font-mono text-[0.625rem] font-normal text-muted-foreground">
                    #{lane.conversation}
                  </span>
                </span>
              ) : (
                <ConversationRef
                  className="text-[0.7812rem] leading-5 text-foreground"
                  id={lane.conversation}
                />
              )}
              <span className="flex min-w-0 items-center gap-1.5 font-mono text-[0.625rem] leading-4 text-muted-foreground">
                <span className={cn('shrink-0', laneTone(state))}>{laneWord(state)}</span>
                {lane.agent && !standing && (
                  <span className="shrink-0">
                    · {lane.kind === 'branch' ? 'branch · coordinator' : lane.agent}
                  </span>
                )}
                {lane.model && <span className="truncate">· {modelName(lane.model)}</span>}
              </span>
            </span>
          </button>
          <button
            aria-label={`Show only #${lane.conversation} in the stream`}
            className="shrink-0 cursor-pointer rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 pointer-coarse:opacity-100"
            onClick={onFilter}
            title="Show only this conversation in the stream"
            type="button"
          >
            <ListFilterIcon className="size-3" />
          </button>
        </div>
        <div className="relative h-7 min-w-0 md:flex-1" data-timeline>
          <Grid window={window} />
          {lane.runs.map((item, index) => (
            <Block
              key={item.start}
              now={now}
              onSelect={() => {
                setSelected(selected === item.start ? undefined : item.start)
                onPick(selected !== item.start)
              }}
              run={item}
              selected={item.start === selected}
              since={since}
              tone={
                item.end === undefined
                  ? 'running'
                  : state === 'waits' && index === lane.runs.length - 1
                    ? 'waiting'
                    : 'done'
              }
            />
          ))}
        </div>
      </div>
      {run && (
        <div className="pb-2 md:pl-[15.75rem]">
          <Calls run={run} />
        </div>
      )}
    </li>
  )
}
