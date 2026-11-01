// Adapted from vercel/ai-elements packages/elements/src/prompt-input.tsx (Apache-2.0, see LICENSE).
// Changes: the form, an autosizing textarea, footer, and submit/stop button only; no attachments or `ai` status.
import { cn } from 'cn'
import { ArrowUpIcon, SquareIcon } from 'lucide-react'
import type { ComponentProps } from 'react'
import { useLayoutEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'

export const PromptInput = ({ className, ...props }: ComponentProps<'form'>) => (
  <form
    className={cn(
      'flex w-full flex-col rounded-xl border border-input/80 bg-card shadow-sm transition-colors focus-within:border-ring/70',
      className,
    )}
    {...props}
  />
)

export type PromptInputTextareaProps = ComponentProps<'textarea'> & { maxHeight?: number }

/** Grows with its content up to `maxHeight`, then scrolls. */
export const PromptInputTextarea = ({
  className,
  maxHeight = 320,
  value,
  ...props
}: PromptInputTextareaProps) => {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`
  }, [value, maxHeight])
  return (
    <textarea
      className={cn(
        'block w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[14px] leading-relaxed outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed',
        className,
      )}
      ref={ref}
      rows={1}
      value={value}
      {...props}
    />
  )
}

export const PromptInputFooter = ({ className, ...props }: ComponentProps<'div'>) => (
  <div
    className={cn('flex items-center justify-between gap-2 px-2 pt-1 pb-2', className)}
    {...props}
  />
)

export const PromptInputTools = ({ className, ...props }: ComponentProps<'div'>) => (
  <div className={cn('flex min-w-0 items-center gap-1', className)} {...props} />
)

export type PromptInputSubmitProps = ComponentProps<typeof Button> & {
  /** `stop` turns the button into an abort button. */
  mode?: 'send' | 'stop'
}

export const PromptInputSubmit = ({
  className,
  mode = 'send',
  children,
  ...props
}: PromptInputSubmitProps) => (
  <Button
    aria-label={mode === 'stop' ? 'Stop' : 'Send'}
    className={cn('size-7 rounded-lg', className)}
    size="icon"
    type={mode === 'stop' ? 'button' : 'submit'}
    variant={mode === 'stop' ? 'secondary' : 'default'}
    {...props}
  >
    {children ??
      (mode === 'stop' ? (
        <SquareIcon className="size-3 fill-current" />
      ) : (
        <ArrowUpIcon className="size-4" />
      ))}
  </Button>
)
