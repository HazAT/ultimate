/**
 * A request or response body as a tree: structure first, every object, array and long string folded to one line with
 * its size, and `cache_control` markers shown where they sit. Folded content never renders, so a 2 MB body costs one
 * row per top-level item until someone opens it.
 */
import { ChevronRightIcon } from 'lucide-react'
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn, formatBytes } from '@/sdk'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type JsonObject = { [key: string]: Json }

const isObject = (value: Json): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isBranch = (value: Json): value is JsonObject | Json[] =>
  typeof value === 'object' && value !== null
/** A string short enough to read inline. */
const SHORT = 96
const isShort = (value: string) => value.length <= SHORT && !value.includes('\n')

/** The first line of prose in a string, for a folded row's hint. */
const firstLine = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? ''

/** The text a folded item is best recognised by: its text, description, content or arguments. */
function hintOf(value: Json): string {
  if (typeof value === 'string') return firstLine(value)
  if (Array.isArray(value)) {
    const first = value.find((item) => hintOf(item))
    return first === undefined ? '' : hintOf(first)
  }
  if (!isObject(value)) return ''
  for (const key of [
    'text',
    'thinking',
    'partial_json',
    'delta',
    'description',
    'content',
    'input',
    'arguments',
    'output',
    'summary',
  ]) {
    const field = value[key]
    if (field === undefined) continue
    const hint = typeof field === 'string' ? firstLine(field) : hintOf(field)
    if (hint) return hint
  }
  return ''
}

/** What an item is: a tool's name, a message's role, a block's type and the tool it calls; never its label again. */
function kindOf(value: Json, label: ReactNode): string {
  if (!isObject(value)) return ''
  const name = typeof value.name === 'string' ? value.name : undefined
  const type = typeof value.type === 'string' && value.type !== label ? value.type : undefined
  const role = typeof value.role === 'string' ? value.role : undefined
  if (role) return [role, type && type !== 'message' ? type : undefined].filter(Boolean).join(' · ')
  if (type && name) return `${type} · ${name}`
  return name ?? type ?? ''
}

/** How many blocks or items a branch holds, for its row. */
function countOf(value: JsonObject | Json[]): string {
  if (Array.isArray(value)) return `${value.length}`
  const content = value.content
  if (Array.isArray(content)) return `${content.length} block${content.length === 1 ? '' : 's'}`
  return ''
}

type Marker = { ttl?: string }
/** The cache marker on `value` itself. */
const markerOf = (value: Json): Marker | undefined => {
  if (!isObject(value) || !isObject(value.cache_control ?? null)) return undefined
  const control = value.cache_control as JsonObject
  return typeof control.ttl === 'string' ? { ttl: control.ttl } : {}
}

/** A cache breakpoint: the provider caches everything up to and including the item it sits on. */
export function CacheMark({ ttl, inside = false }: { ttl?: string; inside?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-sm px-1 font-mono text-[10.5px] leading-4',
        inside ? 'text-brand/70' : 'bg-brand/15 text-brand',
      )}
      title={
        inside
          ? 'A cache breakpoint sits inside'
          : 'cache_control: the provider caches the prefix up to and including this item'
      }
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {inside ? 'cache inside' : `cache${ttl ? ` ${ttl}` : ''}`}
    </span>
  )
}

/** A folded row: chevron, label, what it is, a hint, markers and its size; opens to `children`. */
function Fold({
  label,
  kind,
  hint,
  size,
  marks,
  defaultOpen = false,
  children,
}: {
  label: ReactNode
  kind?: string
  hint?: string
  size: number
  marks?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger className="flex h-6 w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm pr-2 pl-1 text-left hover:bg-accent/50">
        <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/60 transition-transform [[data-state=open]>&]:rotate-90" />
        <span className="shrink-0 text-muted-foreground">{label}</span>
        {kind && <span className="shrink-0 text-foreground/90">{kind}</span>}
        <span className="min-w-0 flex-1 truncate text-muted-foreground/60">{hint}</span>
        {marks}
        <span className="w-16 shrink-0 text-right text-muted-foreground/70 tabular-nums">
          {formatBytes(size)}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-[9px] border-l border-border/60 pl-2">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** A long string, readable as it was sent. */
export function TextBlock({ text, className }: { text: string; className?: string }) {
  return (
    <pre
      className={cn(
        'my-1 max-h-[32rem] overflow-auto rounded-sm bg-terminal px-2.5 py-2 text-[11.5px] leading-[1.55] break-words whitespace-pre-wrap text-foreground/85',
        className,
      )}
    >
      {text}
    </pre>
  )
}

/** A string, number, boolean or null as JSON writes it. */
const scalar = (value: Json) => JSON.stringify(value)

/** One field or item of a branch. */
export function Node({
  label,
  value,
  defaultOpen,
}: {
  label: ReactNode
  value: Json
  defaultOpen?: boolean
}) {
  if (typeof value === 'string' && !isShort(value))
    return (
      <Fold hint={firstLine(value)} label={label} size={value.length} defaultOpen={defaultOpen}>
        <TextBlock text={value} />
      </Fold>
    )
  if (!isBranch(value))
    return (
      <div className="flex min-h-6 min-w-0 items-baseline gap-2 py-0.5 pr-2 pl-6">
        <span className="shrink-0 text-muted-foreground">{label}</span>
        <span
          className={cn(
            'min-w-0 break-all',
            typeof value === 'string' ? 'text-foreground/85' : 'text-brand/90',
          )}
        >
          {scalar(value)}
        </span>
      </div>
    )
  return <Branch defaultOpen={defaultOpen} label={label} value={value} />
}

function Branch({
  label,
  value,
  defaultOpen,
}: {
  label: ReactNode
  value: JsonObject | Json[]
  defaultOpen?: boolean
}) {
  const json = useMemo(() => JSON.stringify(value), [value])
  const marker = markerOf(value)
  const inside = !marker && json.includes('"cache_control"')
  const count = countOf(value)
  return (
    <Fold
      defaultOpen={defaultOpen}
      hint={hintOf(value)}
      kind={[kindOf(value, label), count && Array.isArray(value) ? `${count} items` : count]
        .filter(Boolean)
        .join(' · ')}
      label={label}
      marks={marker ? <CacheMark ttl={marker.ttl} /> : inside ? <CacheMark inside /> : undefined}
      size={json.length}
    >
      <Children value={value} />
    </Fold>
  )
}

/** A branch's fields in order, or its items by index; a message's content opens with it. */
export function Children({ value }: { value: JsonObject | Json[] }) {
  if (Array.isArray(value))
    return value.map((item, index) => (
      // oxlint-disable-next-line react/no-array-index-key -- Items of a sent body are positional.
      <Node key={index} label={`[${index}]`} value={item} />
    ))
  return Object.entries(value).map(([key, item]) =>
    key === 'cache_control' && isObject(item) ? (
      <div className="flex h-6 items-center gap-2 pr-2 pl-6" key={key}>
        <span className="text-muted-foreground">{key}</span>
        <CacheMark ttl={typeof item.ttl === 'string' ? item.ttl : undefined} />
        <span className="text-muted-foreground/60">{JSON.stringify(item)}</span>
      </div>
    ) : (
      <Node
        defaultOpen={key === 'content' && Array.isArray(item) && item.length <= 8}
        key={key}
        label={key}
        value={item}
      />
    ),
  )
}

/** A heading over one part of a body, with its count and size. */
export function Part({
  title,
  note,
  size,
  children,
}: {
  title: string
  note?: ReactNode
  size?: number
  children: ReactNode
}) {
  return (
    <section className="mt-5 first:mt-0">
      <div className="flex items-baseline gap-2 border-b border-border/60 pr-2 pb-1">
        <h3 className="section-label shrink-0 text-foreground/80">{title}</h3>
        {note && <span className="min-w-0 truncate text-muted-foreground/70">{note}</span>}
        {size !== undefined && (
          <span className="ml-auto shrink-0 text-muted-foreground/70 tabular-nums">
            {formatBytes(size)}
          </span>
        )}
      </div>
      <div className="pt-1">{children}</div>
    </section>
  )
}

/** Fields of a flat record (headers, settings), one per line. */
export function Fields({ fields }: { fields: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)] gap-x-4 gap-y-0.5 px-1 py-1">
      {fields.map(([key, value]) => (
        <div className="contents" key={key}>
          <dt className="truncate text-muted-foreground">{key}</dt>
          <dd className="min-w-0 break-all text-foreground/85">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export type { Json, JsonObject }
export { isObject, isBranch, scalar }
