import { ArrowDownIcon, ArrowUpIcon } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { Show, createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { cn } from '@/sdk/solid'

export type Sort<K extends string> = { key: K; ascending: boolean } | undefined
export type Value = number | string
export type Columns<K extends string, T> = Record<K, { value: (row: T) => Value }>

export function useSort<K extends string>() {
  const [sort, setSort] = createSignal<Sort<K>>()
  const onSort = (key: K, text = false) =>
    setSort((current) =>
      current?.key === key ? { key, ascending: !current.ascending } : { key, ascending: text },
    )
  return { sort, onSort }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function sorted<K extends string, T>(rows: T[], sort: Sort<K>, columns: Columns<K, T>): T[] {
  if (!sort) return rows
  const { value } = columns[sort.key]
  const sign = sort.ascending ? 1 : -1
  return rows
    .map((row) => ({ row, at: value(row) }))
    .toSorted(
      (a, b) =>
        sign *
        (typeof a.at === 'number' && typeof b.at === 'number'
          ? a.at - b.at
          : collator.compare(String(a.at), String(b.at))),
    )
    .map((entry) => entry.row)
}

export function SortHead<K extends string>(props: {
  table: string
  column: K
  sort: Sort<K>
  onSort: (key: K, text?: boolean) => void
  text?: boolean
  right?: boolean
  class?: string
  title?: string
  children: JSX.Element
}) {
  const active = () => props.sort?.key === props.column
  const arrow = () => {
    const Arrow = active() && props.sort?.ascending ? ArrowUpIcon : ArrowDownIcon
    return <Arrow class={cn('size-2.5 shrink-0', !active() && 'hidden')} />
  }
  return (
    <span class={cn(props.right && 'text-right', props.class)}>
      <Button
        aria-label={`Sort ${props.table} by ${props.column}`}
        class={cn(
          'inline-flex h-auto max-w-full items-center text-[length:inherit] gap-0.5 rounded-sm font-normal outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
          active() && 'text-foreground',
        )}
        onClick={() => props.onSort(props.column, props.text)}
        size={null}
        title={props.title}
        variant={null}
      >
        <Show when={props.right}>{arrow()}</Show>
        <span class="truncate">{props.children}</span>
        <Show when={!props.right}>{arrow()}</Show>
      </Button>
    </span>
  )
}
