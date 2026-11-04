// Adapted from vercel/ai-elements packages/elements/src/reasoning.tsx (Apache-2.0, see LICENSE).
// Changes: collapsed by default, also while streaming (the trigger shimmers instead); no auto open/close or timer.
import { cn } from 'cn'
import { ChevronRightIcon } from 'lucide-react'
import type { ComponentProps } from 'react'
import { createContext, memo, useContext } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { MessageResponse } from './message.tsx'
import { Shimmer } from './shimmer.tsx'

const ReasoningContext = createContext({ isStreaming: false })

export type ReasoningProps = ComponentProps<typeof Collapsible> & { isStreaming?: boolean }

export const Reasoning = memo(({ className, isStreaming = false, ...props }: ReasoningProps) => (
  <ReasoningContext.Provider value={{ isStreaming }}>
    <Collapsible className={cn('group/reasoning not-prose', className)} {...props} />
  </ReasoningContext.Provider>
))
Reasoning.displayName = 'Reasoning'

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger> & { label?: string }

export const ReasoningTrigger = memo(
  ({ className, children, label = 'Thinking', ...props }: ReasoningTriggerProps) => {
    const { isStreaming } = useContext(ReasoningContext)
    return (
      <CollapsibleTrigger
        className={cn(
          'flex items-center gap-1.5 font-mono text-[0.75rem] text-muted-foreground transition-colors hover:text-foreground',
          className,
        )}
        data-ui="transcript-meta"
        {...props}
      >
        {children ?? (
          <>
            <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/reasoning:rotate-90" />
            {isStreaming ? <Shimmer>{`${label}…`}</Shimmer> : <span>{label}</span>}
          </>
        )}
      </CollapsibleTrigger>
    )
  },
)
ReasoningTrigger.displayName = 'ReasoningTrigger'

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent> & { children: string }

export const ReasoningContent = memo(({ className, children, ...props }: ReasoningContentProps) => {
  const { isStreaming } = useContext(ReasoningContext)
  return (
    <CollapsibleContent
      className={cn(
        'mt-1.5 border-l-2 border-border pl-3 text-[0.8125rem] text-muted-foreground italic',
        className,
      )}
      {...props}
    >
      <MessageResponse isAnimating={isStreaming}>{children}</MessageResponse>
    </CollapsibleContent>
  )
})
ReasoningContent.displayName = 'ReasoningContent'
