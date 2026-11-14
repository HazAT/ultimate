/** The project rail's point for other extensions' items, and `RailItem`, which lays one out like a project row. */
import type { ReactNode } from 'react'
import { cn, definePoint } from '@/sdk'

/**
 * Items at the end of the rail's list: a link or a button such as a shortcut, a project that is not running or a way
 * to add one. Several extensions may provide it and their items show in discovery order. `wide` is whether the rail is
 * open, with names, or folded to its column of swatches; `RailItem` matches the rows either way.
 */
export const RailItems = definePoint<{ wide: boolean }, ReactNode>('projects.rail-items')

/** A row's box: 40 px high, inset from the rail's edges. */
export const rowBox =
  'group relative mx-1.5 flex h-10 items-center rounded-lg text-left outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset'
/** A row's swatch column: what stays visible while the rail is folded, centred on the rail's axis. */
export const swatchColumn = 'flex h-full w-11 shrink-0 justify-center'

/**
 * One item laid out like a project row: `mark` in the swatch column, always shown, and `label` beside it while the rail
 * is open. A link with `href`, a button otherwise; `title` names it when folded.
 */
export function RailItem({
  wide,
  mark,
  label,
  title,
  href,
  onClick,
}: {
  wide: boolean
  mark: ReactNode
  label: ReactNode
  title: string
  href?: string
  onClick?: () => void
}) {
  const className = cn(rowBox, 'cursor-pointer', wide && 'hover:bg-sidebar-accent/50')
  const content = (
    <>
      <span className={cn(swatchColumn, 'items-center py-px')}>{mark}</span>
      {wide && <span className="flex min-w-0 flex-1 items-center pr-2.5 pl-1.5">{label}</span>}
    </>
  )
  if (href)
    return (
      <a aria-label={title} className={className} href={href} onClick={onClick} title={title}>
        {content}
      </a>
    )
  return (
    <button aria-label={title} className={className} onClick={onClick} title={title} type="button">
      {content}
    </button>
  )
}
