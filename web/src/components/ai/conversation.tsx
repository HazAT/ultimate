import { cn } from 'cn'
import { ArrowDownIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom'
import { Button } from '@/components/ui/button'

export const Conversation = ({ className, ...props }: ComponentProps<typeof StickToBottom>) => (
  <StickToBottom
    className={cn('relative flex-1 overflow-y-hidden', className)}
    initial="instant"
    resize="smooth"
    role="log"
    {...props}
  />
)

export const ConversationContent = ({
  className,
  ...props
}: ComponentProps<typeof StickToBottom.Content>) => (
  <StickToBottom.Content className={cn('flex flex-col', className)} {...props} />
)

export const ConversationEmptyState = ({
  className,
  title,
  description,
  icon,
  children,
  ...props
}: ComponentProps<'div'> & { title?: string; description?: string; icon?: ReactNode }) => (
  <div
    className={cn(
      'flex size-full flex-col items-center justify-center gap-3 p-8 text-center',
      className,
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          {title && <h3 className="text-sm font-medium">{title}</h3>}
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
      </>
    )}
  </div>
)

export const ConversationScrollButton = ({
  className,
  ...props
}: ComponentProps<typeof Button>) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()
  if (isAtBottom) return null
  return (
    <Button
      aria-label="Scroll to bottom"
      className={cn(
        'absolute bottom-3 left-1/2 size-7 -translate-x-1/2 rounded-full bg-popover shadow-md',
        className,
      )}
      onClick={() => void scrollToBottom()}
      size="icon"
      type="button"
      variant="outline"
      {...props}
    >
      <ArrowDownIcon className="size-3.5" />
    </Button>
  )
}
