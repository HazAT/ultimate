import { ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'
import { cn } from 'cn'

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

function Scalar({ value }: { value: Json }) {
  if (typeof value === 'string')
    return <span className="break-all text-diff-add">{JSON.stringify(value)}</span>
  if (typeof value === 'number') return <span className="text-brand">{value}</span>
  return <span className="text-warning">{JSON.stringify(value)}</span>
}

function preview(value: Json): string {
  if (Array.isArray(value)) return `[${value.length}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
    return `{${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''}}`
  }
  return JSON.stringify(value)
}

function Node({
  name,
  value,
  depth,
  open: initial,
}: {
  name?: string
  value: Json
  depth: number
  open: number
}) {
  const nested = value !== null && typeof value === 'object'
  const [open, setOpen] = useState(depth < initial)
  const label = name !== undefined && <span className="text-foreground/75">{name}: </span>
  if (!nested)
    return (
      <div className="flex min-w-0" style={{ paddingLeft: `${depth * 0.9 + 0.9}rem` }}>
        <span className="min-w-0 break-words">
          {label}
          <Scalar value={value} />
        </span>
      </div>
    )
  const entries = Array.isArray(value)
    ? value.map((item, index): [string, Json] => [String(index), item])
    : Object.entries(value)
  return (
    <>
      <button
        className="flex w-full min-w-0 items-center gap-0.5 text-left hover:bg-accent/40"
        onClick={() => setOpen(!open)}
        style={{ paddingLeft: `${depth * 0.9}rem` }}
        type="button"
      >
        <ChevronRightIcon
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className="min-w-0 truncate">
          {label}
          <span className="text-muted-foreground">
            {open
              ? Array.isArray(value)
                ? `[${value.length}]`
                : `{${entries.length}}`
              : preview(value)}
          </span>
        </span>
      </button>
      {open &&
        entries.map(([key, item]) => (
          <Node depth={depth + 1} key={key} name={key} open={initial} value={item} />
        ))}
    </>
  )
}

/** JSON as a collapsible tree; levels below `open` start expanded. */
export function JsonTree({
  value,
  open = 2,
  className,
}: {
  value: unknown
  open?: number
  className?: string
}) {
  return (
    <div className={cn('font-mono text-[0.7188rem] leading-[1.6]', className)}>
      <Node depth={0} open={open} value={value as Json} />
    </div>
  )
}
