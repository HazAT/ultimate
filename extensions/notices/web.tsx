import { CircleAlertIcon, InfoIcon, TriangleAlertIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { cn, defineWebExtension, useNotices, useNow } from '@/sdk'
import type { Notice } from '@/sdk'

/** How long a notice stays, by level; hovering keeps them. */
const lifetime: Record<Notice['level'], number> = { info: 5000, warning: 9000, error: 15000 }
const icons = {
  info: [InfoIcon, 'text-muted-foreground'],
  warning: [TriangleAlertIcon, 'text-warning'],
  error: [CircleAlertIcon, 'text-error'],
} as const

/** Server and client notices as small toasts centred under the header, clear of the side panels. */
function Toasts() {
  const notices = useNotices()
  const [dismissed, setDismissed] = useState<ReadonlySet<number>>(new Set())
  const [hovered, setHovered] = useState(false)
  const live = notices.some((notice) => Date.now() - notice.at < lifetime[notice.level])
  const now = useNow(500, live && !hovered)
  const shown = notices
    .filter(
      (notice) =>
        !dismissed.has(notice.id) && (hovered || now - notice.at < lifetime[notice.level]),
    )
    .slice(-4)
  if (shown.length === 0) return null
  return (
    <div
      className="fixed top-12 left-1/2 z-40 flex w-80 max-w-[calc(100vw-1.5rem)] -translate-x-1/2 flex-col divide-y divide-border/70 overflow-hidden rounded-md border border-border/80 bg-popover shadow-lg"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="status"
    >
      {shown.map((notice) => {
        const [Icon, tone] = icons[notice.level]
        return (
          <div
            className={cn(
              'group/notice flex items-start gap-2 px-2.5 py-2 font-mono text-[0.7188rem] leading-snug',
              notice.level === 'error' && 'bg-error/6',
              notice.level === 'warning' && 'bg-warning/6',
            )}
            key={notice.id}
          >
            <Icon className={cn('mt-px size-3.5 shrink-0', tone)} />
            <span className="min-w-0 flex-1 break-words text-foreground/90">{notice.message}</span>
            <button
              aria-label="Dismiss"
              className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/notice:opacity-100 pointer-coarse:opacity-100 hover:text-foreground"
              onClick={() => setDismissed((previous) => new Set([...previous, notice.id]))}
              type="button"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

export default defineWebExtension({ slots: { overlay: Toasts } })
