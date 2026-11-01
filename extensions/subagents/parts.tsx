import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@/sdk'

export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-sm border border-border/80 px-1 text-[10px] leading-4 text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  )
}

export function Heading({ children, meta }: { children: ReactNode; meta: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 pb-2 section-label">
      {children}
      <span className="ml-auto flex items-center gap-2 text-muted-foreground">{meta}</span>
    </div>
  )
}

/** Calls `refetch` when the window regains focus and when `key` changes after mount. */
export function useRefresh(refetch: () => unknown, key?: string) {
  const last = useRef(key)
  useEffect(() => {
    if (last.current === key) return
    last.current = key
    void refetch()
  }, [key, refetch])
  useEffect(() => {
    const refresh = () => void refetch()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refetch])
}
