import { cn } from 'cn'
import type { ComponentProps } from 'react'

export const ConversationEmptyState = ({ className, ...props }: ComponentProps<'div'>) => (
  <div
    className={cn(
      'flex size-full flex-col items-center justify-center gap-3 p-8 text-center',
      className,
    )}
    {...props}
  />
)
