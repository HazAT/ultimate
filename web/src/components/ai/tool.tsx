// Adapted from vercel/ai-elements packages/elements/src/tool.tsx (Apache-2.0, see LICENSE).
// Changes: Pi Durable call states instead of `ai` tool parts; a dense one-line header with title and meta.
import { cn } from 'cn'
import {
  CheckIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
  MinusCircleIcon,
  XIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { AnsiOutput } from './ansi-output.tsx'
import { CodeBlock } from './code-block.tsx'

export type ToolState = 'streaming' | 'pending' | 'running' | 'done' | 'error' | 'interrupted'

export const Tool = ({ className, ...props }: ComponentProps<typeof Collapsible>) => (
  <Collapsible
    className={cn(
      'group/tool not-prose w-full overflow-hidden rounded-md border border-border/80 bg-card/50 font-mono text-[0.75rem]',
      className,
    )}
    {...props}
  />
)

const labels: Record<ToolState, string> = {
  streaming: 'writing call',
  pending: 'queued',
  running: 'running',
  done: 'done',
  error: 'failed',
  interrupted: 'interrupted',
}

const icons = {
  streaming: [CircleDashedIcon, 'text-muted-foreground'],
  pending: [CircleDashedIcon, 'text-muted-foreground'],
  running: [LoaderCircleIcon, 'animate-spin text-brand'],
  done: [CheckIcon, 'text-success'],
  error: [XIcon, 'text-error'],
  interrupted: [MinusCircleIcon, 'text-warning'],
} as const

/** The call's state; `icon`, the tool's own, stands in for the check mark once it is done. */
export const ToolStatusIcon = ({
  state,
  className,
  icon,
}: {
  state: ToolState
  className?: string
  icon?: LucideIcon
}) => {
  const [Icon, tone] = icon && state === 'done' ? [icon, 'text-brand'] : icons[state]
  return <Icon aria-label={labels[state]} className={cn('size-3.5 shrink-0', tone, className)} />
}

export type ToolHeaderProps = Omit<ComponentProps<typeof CollapsibleTrigger>, 'title'> & {
  name: string
  state: ToolState
  /** The tool's icon, shown in place of the check mark once the call is done. */
  icon?: LucideIcon
  /** What the call works on: a path, a command. */
  title?: ReactNode
  /** Right-aligned facts: duration, size, exit code. */
  meta?: ReactNode
  /** A control after the toggle, such as a cancel button: outside the trigger, so it can be a real button. */
  action?: ReactNode
}

export const ToolHeader = ({ action, ...props }: ToolHeaderProps) =>
  action ? (
    <div className="flex items-center pr-1.5">
      <ToolTrigger {...props} />
      {action}
    </div>
  ) : (
    <ToolTrigger {...props} />
  )

const ToolTrigger = ({
  className,
  name,
  state,
  icon,
  title,
  meta,
  ...props
}: Omit<ToolHeaderProps, 'action'>) => (
  <CollapsibleTrigger
    className={cn(
      'flex h-8 w-full min-w-0 items-center gap-2 px-2.5 text-left transition-colors hover:bg-accent/40',
      className,
    )}
    {...props}
  >
    <ToolStatusIcon icon={icon} state={state} />
    {name && <span className="shrink-0 font-medium text-foreground">{name}</span>}
    <span className="min-w-0 flex-1 truncate text-muted-foreground">{title}</span>
    {meta && (
      <span className="flex shrink-0 items-center gap-2 text-[0.6875rem] text-muted-foreground tabular-nums">
        {meta}
      </span>
    )}
    <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/tool:rotate-90" />
  </CollapsibleTrigger>
)

export const ToolContent = ({ className, ...props }: ComponentProps<typeof CollapsibleContent>) => (
  <CollapsibleContent className={cn('border-t border-border/80', className)} {...props} />
)

export const ToolSection = ({
  className,
  label,
  children,
  ...props
}: ComponentProps<'div'> & { label?: string }) => (
  <div className={cn('space-y-1 px-2.5 py-2', className)} {...props}>
    {label && <div className="section-label">{label}</div>}
    {children}
  </div>
)

export const ToolInput = ({ input, ...props }: ComponentProps<'div'> & { input: unknown }) => (
  <ToolSection label="Arguments" {...props}>
    <CodeBlock className="border-none" code={JSON.stringify(input, null, 2)} language="json" />
  </ToolSection>
)

export const ToolOutput = ({
  output,
  isError,
  ...props
}: ComponentProps<'div'> & { output: string; isError?: boolean }) =>
  output ? (
    <ToolSection label={isError ? 'Error' : 'Output'} {...props}>
      <pre
        className={cn(
          'max-h-80 overflow-auto rounded-sm bg-terminal px-2.5 py-2 leading-[1.55] whitespace-pre-wrap',
          isError ? 'text-error' : 'text-foreground/90',
        )}
      >
        <AnsiOutput output={output} />
      </pre>
    </ToolSection>
  ) : null

export const ToolDiagnostics = ({
  diagnostics,
  ...props
}: ComponentProps<'div'> & {
  diagnostics: readonly { severity: 'info' | 'warn' | 'error'; message: string }[]
}) =>
  diagnostics.length ? (
    <ToolSection {...props}>
      {diagnostics.map((diagnostic, index) => (
        <div
          className={cn(
            'break-words',
            diagnostic.severity === 'error'
              ? 'text-error'
              : diagnostic.severity === 'warn'
                ? 'text-warning'
                : 'text-muted-foreground',
          )}
          // oxlint-disable-next-line react/no-array-index-key -- Result diagnostics have no id and may repeat.
          key={index}
        >
          {diagnostic.message}
        </div>
      ))}
    </ToolSection>
  ) : null

/** An image of a tool result as a thumbnail; a click opens it full size. */
export const ToolImage = ({
  image,
  className,
  alt = 'Tool result image',
}: {
  image: { data: string; mimeType: string }
  className?: string
  alt?: string
}) => {
  const src = `data:${image.mimeType};base64,${image.data}`
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          className={cn(
            'block cursor-zoom-in overflow-hidden rounded-sm border border-border/80 bg-terminal transition-colors hover:border-brand/60',
            className,
          )}
          type="button"
        >
          <img alt={alt} className="max-h-48 max-w-full object-contain" src={src} />
        </button>
      </DialogTrigger>
      <DialogContent
        className="w-auto max-w-[94vw] border-border/80 bg-terminal p-2 sm:max-w-[94vw]"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        <img alt={alt} className="max-h-[88vh] max-w-[90vw] object-contain" src={src} />
      </DialogContent>
    </Dialog>
  )
}

/** The images of a tool result, such as screenshots. */
export const ToolImages = ({
  images,
  ...props
}: ComponentProps<'div'> & { images: readonly { data: string; mimeType: string }[] }) =>
  images.length ? (
    <ToolSection label={images.length > 1 ? `${images.length} images` : 'Image'} {...props}>
      <div className="flex flex-wrap gap-2">
        {images.map((image, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- Fixed result images may contain duplicates.
          <ToolImage image={image} key={index} />
        ))}
      </div>
    </ToolSection>
  ) : null
