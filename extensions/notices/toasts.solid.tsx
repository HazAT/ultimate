/** @jsxImportSource @solidjs/web */
import { CircleAlert, Info, TriangleAlert, X } from '@lucide/solid'
import { createEffect, onSettled } from 'solid-js'
import { Dynamic } from '@solidjs/web'
import {
  createToaster,
  Toast,
  ToastClose,
  ToastRegion,
  ToastTitle,
} from '@/components/ui/toast.solid.tsx'
import type { Notice } from '@/sdk'
import { cn, useNotices } from '@/sdk/solid'

const shownAtOnce = 4
const lifetimeMs: Record<Notice['level'], number> = { info: 5000, warning: 9000, error: 15000 }
const icons = {
  info: { icon: Info, tone: 'text-muted-foreground' },
  warning: { icon: TriangleAlert, tone: 'text-warning' },
  error: { icon: CircleAlert, tone: 'text-error' },
}

export function Toasts() {
  const notices = useNotices()
  const toast = createToaster()
  let seen = 0
  createEffect(notices, (all) => {
    for (const notice of all) {
      if (notice.id <= seen) continue
      seen = notice.id
      const duration = lifetimeMs[notice.level] - (Date.now() - notice.at)
      if (duration <= 0) continue
      const full = toast.toasts()[shownAtOnce - 1]
      if (full) toast.dismiss(full.id)
      toast({ title: notice.message, type: notice.level, duration, data: notice })
    }
  })
  onSettled(() => () => toast.dismiss())
  return (
    <ToastRegion aria-label="Notices" maxVisible={shownAtOnce} toaster={toast}>
      {(item) => {
        const notice = item.data as Notice & { id: number }
        const look = icons[notice.level]
        return (
          <Toast>
            <Dynamic class={cn('mt-px size-3.5 shrink-0', look.tone)} component={look.icon} />
            <ToastTitle class="min-w-0 flex-1 break-words text-foreground/90" />
            <ToastClose aria-label={`Dismiss notice ${notice.id}: ${notice.message}`}>
              <X class="size-3.5" />
            </ToastClose>
          </Toast>
        )
      }}
    </ToastRegion>
  )
}
