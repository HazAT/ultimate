/* oxlint-disable react/no-array-index-key -- A spec is immutable data without ids: its rows and blocks never reorder. */
import { useLayoutEffect, useRef, useState } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/sdk'
import type { Block, Field, Leaf, SketchForm, Value } from './refs.ts'

/** Series colours: the brand first, then the status tones, so charts follow the theme. */
const TONES = ['var(--brand)', 'var(--success)', 'var(--warning)', 'var(--error)']

const number = (value: unknown) => (typeof value === 'number' ? value : Number(value) || 0)
/** 1234 → "1,234", 0.5 → "0.5": short, for axis and value labels. */
const short = (value: number) =>
  Math.abs(value) >= 10_000
    ? `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k`
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 })

type Chart = Extract<Leaf, { type: 'chart' }>

/** The round number at or above `value` an axis ends at: 37 → 40, 126 → 150, 0.8 → 1. */
function nice(value: number) {
  if (value <= 0) return 0
  const step = 10 ** Math.floor(Math.log10(value))
  return (
    [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((f) => f * step).find((top) => top >= value) ??
    10 * step
  )
}

/** The element's width in CSS pixels, followed as it resizes. */
function useWidth<T extends Element>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(600)
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)))
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

/** A bar or line chart drawn as SVG at its card's width, so its labels keep their size on a phone. */
function ChartBlock({ block }: { block: Chart }) {
  const [hover, setHover] = useState<number>()
  const [ref, measured] = useWidth<HTMLElement>()
  const W = Math.max(240, measured)
  const H = W < 480 ? 160 : 200
  const pad = { top: 16, right: 8, bottom: 22, left: 36 }
  const values = block.data.flatMap((row) => block.series.map((s) => number(row[s.field])))
  const max = nice(Math.max(...values, 0))
  const low = Math.min(...values, 0)
  const min = low < 0 ? -nice(-low) : 0
  const span = max - min || 1
  const y = (value: number) => pad.top + (1 - (value - min) / span) * (H - pad.top - pad.bottom)
  const inner = W - pad.left - pad.right
  const slot = inner / block.data.length
  const x = (index: number) => pad.left + slot * index + slot / 2
  const ticks = [min, min + span / 2, max]
  // Every label when they fit (about 64 px each), else every nth.
  const every = Math.ceil(block.data.length / Math.max(2, Math.floor(inner / 64)))
  const multi = block.series.length > 1
  const bar = Math.min(48, (slot * 0.7) / block.series.length)
  return (
    <figure className="min-w-0 space-y-1.5" ref={ref}>
      {(block.title || multi) && (
        <figcaption className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          {block.title && <span className="section-label">{block.title}</span>}
          {multi &&
            block.series.map((series, index) => (
              <span
                className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground"
                key={series.field}
              >
                <span className="size-2 rounded-[2px]" style={{ background: TONES[index % 4] }} />
                {series.name}
              </span>
            ))}
        </figcaption>
      )}
      <svg
        aria-label={block.title ?? block.series.map((s) => s.name).join(', ')}
        className="block h-auto w-full overflow-visible"
        onMouseLeave={() => setHover(undefined)}
        role="img"
        viewBox={`0 0 ${W} ${H}`}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              className="stroke-border"
              strokeDasharray={tick === 0 ? undefined : '2 4'}
              x1={pad.left}
              x2={W - pad.right}
              y1={y(tick)}
              y2={y(tick)}
            />
            <text
              className="fill-muted-foreground font-mono text-[11px]"
              dominantBaseline="middle"
              textAnchor="end"
              x={pad.left - 6}
              y={y(tick)}
            >
              {short(tick)}
            </text>
          </g>
        ))}
        {block.data.map((row, index) => (
          <g key={index} onMouseEnter={() => setHover(index)}>
            <rect
              className={cn('fill-foreground/0', hover === index && 'fill-foreground/[0.04]')}
              height={H - pad.top - pad.bottom}
              width={slot}
              x={pad.left + slot * index}
              y={pad.top}
            />
            {index % every === 0 && (
              <text
                className="fill-muted-foreground font-mono text-[11px]"
                textAnchor="middle"
                x={x(index)}
                y={H - 6}
              >
                {String(row[block.x] ?? '')}
              </text>
            )}
            {block.kind === 'bar' &&
              block.series.map((series, s) => {
                const value = number(row[series.field])
                const left = x(index) - (bar * block.series.length) / 2 + bar * s
                return (
                  <g key={series.field}>
                    <rect
                      fill={TONES[s % 4]}
                      height={Math.max(1, Math.abs(y(value) - y(0)))}
                      opacity={hover === undefined || hover === index ? 0.9 : 0.55}
                      rx={2}
                      width={Math.max(2, bar - 2)}
                      x={left + 1}
                      y={Math.min(y(value), y(0))}
                    />
                    {(hover === index || (!multi && block.data.length <= 12)) && (
                      <text
                        className="fill-foreground font-mono text-[11px] tabular-nums"
                        textAnchor="middle"
                        x={left + bar / 2}
                        y={Math.min(y(value), y(0)) - 4}
                      >
                        {short(value)}
                      </text>
                    )}
                  </g>
                )
              })}
          </g>
        ))}
        {block.kind === 'line' &&
          block.series.map((series, s) => (
            <g key={series.field}>
              <polyline
                fill="none"
                points={block.data
                  .map((row, i) => `${x(i)},${y(number(row[series.field]))}`)
                  .join(' ')}
                stroke={TONES[s % 4]}
                strokeLinejoin="round"
                strokeWidth={2}
              />
              {block.data.map((row, i) => (
                <circle
                  cx={x(i)}
                  cy={y(number(row[series.field]))}
                  fill={TONES[s % 4]}
                  key={i}
                  r={hover === i ? 4 : 2.5}
                />
              ))}
            </g>
          ))}
        {block.kind === 'line' && hover !== undefined && (
          <text
            className="fill-foreground font-mono text-[11px] tabular-nums"
            textAnchor="middle"
            x={x(hover)}
            y={pad.top - 4}
          >
            {block.series
              .map((series) => short(number(block.data[hover][series.field])))
              .join(' · ')}
          </text>
        )}
      </svg>
      {block.unit && (
        <div className="text-right font-mono text-[11px] text-muted-foreground">{block.unit}</div>
      )}
    </figure>
  )
}

function Metric({ block }: { block: Extract<Leaf, { type: 'metric' }> }) {
  const down = block.delta?.trim().startsWith('-')
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="section-label">{block.label}</div>
      <div className="text-[28px] leading-9 font-semibold tracking-tight tabular-nums">
        {block.value}
      </div>
      {block.delta && (
        <div className={cn('font-mono text-[11px]', down ? 'text-error' : 'text-success')}>
          {block.delta}
        </div>
      )}
    </div>
  )
}

function Table({ block }: { block: Extract<Leaf, { type: 'table' }> }) {
  const numeric = (key: string) =>
    block.rows.length > 0 &&
    block.rows.every((row) => row[key] == null || typeof row[key] === 'number')
  // Short values (ids, dates, counts) stay on one line; prose columns wrap.
  const brief = (key: string) => block.rows.every((row) => String(row[key] ?? '').length <= 12)
  return (
    <div className="max-h-96 min-w-0 overflow-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead className="sticky top-0 bg-card">
          <tr>
            {block.columns.map((column) => (
              <th
                className={cn(
                  'border-b border-border px-2 py-1.5 font-mono text-[11px] font-normal whitespace-nowrap text-muted-foreground',
                  numeric(column.key) ? 'text-right' : 'text-left',
                )}
                key={column.key}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, index) => (
            <tr className="border-b border-border/50 last:border-0" key={index}>
              {block.columns.map((column) => (
                <td
                  className={cn(
                    'px-2 py-1.5 align-top',
                    numeric(column.key) && 'text-right tabular-nums',
                    brief(column.key) && 'whitespace-nowrap',
                  )}
                  key={column.key}
                >
                  {row[column.key] === true
                    ? '✓'
                    : row[column.key] === false
                      ? '–'
                      : String(row[column.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!block.rows.length && (
        <div className="px-2 py-3 text-center text-[13px] text-muted-foreground">No rows</div>
      )}
    </div>
  )
}

const control =
  'h-8 w-full min-w-0 rounded-md border border-border bg-background px-2.5 text-[13px] outline-none placeholder:text-muted-foreground/70 focus:border-brand/60 disabled:opacity-70 max-md:h-11'

/** The value a field starts at: its default when it fits the field's kind, else the first option, off or empty. */
const initial = (field: Field): Value => {
  const given = field.default
  if (field.kind === 'select')
    return typeof given === 'string' && field.options?.includes(given)
      ? given
      : (field.options?.[0] ?? '')
  if (field.kind === 'toggle') return given === true
  if (field.kind === 'number') return typeof given === 'number' ? given : ''
  return typeof given === 'string' ? given : ''
}

function Input({
  field,
  value,
  set,
  locked,
}: {
  field: Field
  value: Value
  set: (value: Value) => void
  locked: boolean
}) {
  const id = `sketch-${field.name}`
  if (field.kind === 'toggle')
    return (
      <label className="flex items-center justify-between gap-3 py-1" htmlFor={id}>
        <span className="text-[13px]">{field.label}</span>
        <Switch checked={value === true} disabled={locked} id={id} onCheckedChange={set} />
      </label>
    )
  return (
    <label className="block space-y-1" htmlFor={id}>
      <span className="section-label">{field.label}</span>
      {field.kind === 'select' ? (
        <select
          className={control}
          disabled={locked}
          id={id}
          onChange={(event) => set(event.target.value)}
          value={String(value)}
        >
          {(field.options ?? []).map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      ) : (
        <input
          className={control}
          disabled={locked}
          id={id}
          onChange={(event) =>
            set(
              field.kind === 'number' && event.target.value !== ''
                ? Number(event.target.value)
                : event.target.value,
            )
          }
          type={field.kind === 'number' ? 'number' : field.kind === 'date' ? 'date' : 'text'}
          value={String(value)}
        />
      )}
    </label>
  )
}

/** A form: its values go to the agent once, then it shows them, locked. */
function Form({
  block,
  state,
  submit,
}: {
  block: Extract<Leaf, { type: 'form' }>
  state?: SketchForm
  submit?: (values: Record<string, Value>) => Promise<unknown>
}) {
  const [values, setValues] = useState<Record<string, Value>>(() =>
    Object.fromEntries(block.fields.map((field) => [field.name, initial(field)])),
  )
  const [busy, setBusy] = useState(false)
  const sent = state?.submitted
  // Claimed but not delivered (a crash in between): the claimed values can be sent again.
  const stranded = !!sent && !sent.delivered
  const locked = !!sent || busy || !submit
  const shown = sent?.values ?? values
  return (
    <form
      className="min-w-0 space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (busy || !submit || (sent && !stranded)) return
        setBusy(true)
        // A refused submit shows as a notice (api.action); the form stays editable.
        submit(sent?.values ?? values)
          .catch(() => undefined)
          .finally(() => setBusy(false))
      }}
    >
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        {block.fields.map((field) => (
          <div className={cn(field.kind === 'text' && 'sm:col-span-2')} key={field.name}>
            <Input
              field={field}
              locked={locked}
              set={(value) => setValues((previous) => ({ ...previous, [field.name]: value }))}
              value={shown[field.name] ?? initial(field)}
            />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-end gap-3">
        {sent && !stranded && (
          <span className="font-mono text-[11px] text-muted-foreground">
            sent{' '}
            {new Date(sent.at).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              hourCycle: 'h23',
            })}
          </span>
        )}
        <Button disabled={busy || !submit || (!!sent && !stranded)} size="sm" type="submit">
          {stranded ? 'Send again' : sent ? 'Submitted' : block.submit}
        </Button>
      </div>
    </form>
  )
}

export type FormProps = {
  state?: SketchForm
  submit?: (values: Record<string, Value>) => Promise<unknown>
}

function LeafBlock({ block, form }: { block: Leaf; form: FormProps }) {
  if (block.type === 'text')
    return <MessageResponse className="text-[14px]">{block.markdown}</MessageResponse>
  if (block.type === 'metric') return <Metric block={block} />
  if (block.type === 'chart') return <ChartBlock block={block} />
  if (block.type === 'table') return <Table block={block} />
  return <Form block={block} {...form} />
}

/** The spec's blocks, top to bottom; a row puts its blocks side by side and stacks them on narrow screens. */
export function Blocks({ blocks, form }: { blocks: Block[]; form: FormProps }) {
  return (
    <div className="space-y-4">
      {blocks.map((block, index) =>
        block.type === 'row' ? (
          <div className="flex flex-col gap-4 sm:flex-row" key={index}>
            {block.blocks.map((leaf, i) => (
              <div
                className={cn(
                  'min-w-0',
                  leaf.type === 'metric' ? 'sm:w-40 sm:shrink-0' : 'sm:flex-1',
                )}
                key={i}
              >
                <LeafBlock block={leaf} form={form} />
              </div>
            ))}
          </div>
        ) : (
          <LeafBlock block={block} form={form} key={index} />
        ),
      )}
    </div>
  )
}
