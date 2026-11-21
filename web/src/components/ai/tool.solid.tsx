/** @jsxImportSource @solidjs/web */
import { Check, ChevronRight, CircleDashed, LoaderCircle, MinusCircle, X } from '@lucide/solid'
import type { LucideIcon } from '@lucide/solid'
import { dynamic } from '@solidjs/web'
import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import { For, omit, Show } from 'solid-js'
import type { ComponentProps } from 'solid-js'
import { HighlightedCode } from '@/components/markdown/markdown.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog.solid.tsx'
import { AnsiOutput } from './ansi-output.solid.tsx'

export type ToolState = 'streaming' | 'pending' | 'running' | 'done' | 'error' | 'interrupted'

export function Tool(props: ComponentProps<typeof Collapsible> & { class?: string }) {
  const rest = omit(props, 'class')
  return (
    <Collapsible
      {...rest}
      class={cn(
        'group/tool not-prose w-full overflow-hidden rounded-md border border-border/80 bg-card/50 font-mono text-[12px]',
        props.class,
      )}
      data-ui="tool"
    />
  )
}

const statuses = {
  streaming: { icon: CircleDashed, tone: 'text-muted-foreground', label: 'writing call' },
  pending: { icon: CircleDashed, tone: 'text-muted-foreground', label: 'queued' },
  running: { icon: LoaderCircle, tone: 'animate-spin text-brand', label: 'running' },
  done: { icon: Check, tone: 'text-success', label: 'done' },
  error: { icon: X, tone: 'text-error', label: 'failed' },
  interrupted: { icon: MinusCircle, tone: 'text-warning', label: 'interrupted' },
} as const

export function ToolStatusIcon(props: {
  state: ToolState
  class?: string
  icon?: LucideIcon
  'aria-hidden'?: 'true'
}) {
  const customIcon = () => (props.state === 'done' ? props.icon : undefined)
  const status = () => statuses[props.state]
  const Icon = dynamic(() => customIcon() ?? status().icon)
  return (
    <Icon
      aria-hidden={props['aria-hidden']}
      aria-label={props['aria-hidden'] ? undefined : status().label}
      class={cn('size-3.5 shrink-0', customIcon() ? 'text-brand' : status().tone, props.class)}
    >
      <title>{status().label}</title>
    </Icon>
  )
}

export type ToolHeaderProps = Omit<
  ComponentProps<typeof CollapsibleTrigger>,
  'title' | 'children' | 'class'
> & {
  name: string
  state: ToolState
  class?: string
  icon?: LucideIcon
  title?: JSX.Element
  meta?: JSX.Element
  action?: JSX.Element
}

export function ToolHeader(props: ToolHeaderProps) {
  const trigger = omit(props, 'action')
  return (
    <Show when={props.action} fallback={<ToolTrigger {...trigger} />}>
      {(action) => (
        <div class="flex items-center pr-1.5">
          <ToolTrigger {...trigger} />
          {action()}
        </div>
      )}
    </Show>
  )
}

function ToolTrigger(props: Omit<ToolHeaderProps, 'action'>) {
  const rest = omit(props, 'class', 'name', 'state', 'icon', 'title', 'meta')
  return (
    <CollapsibleTrigger
      {...rest}
      class={cn(
        'flex h-8 w-full min-w-0 items-center gap-2 px-2.5 text-left transition-colors hover:bg-accent/40',
        props.class,
      )}
    >
      <ToolStatusIcon aria-hidden="true" icon={props.icon} state={props.state} />
      <Show when={props.name}>
        <span class="shrink-0 font-medium text-foreground">{props.name}</span>
      </Show>{' '}
      <span class="min-w-0 flex-1 truncate text-muted-foreground">{props.title}</span>{' '}
      <Show when={props.meta}>
        {(meta) => (
          <span class="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
            {meta()}
          </span>
        )}
      </Show>
      <ChevronRight
        aria-hidden="true"
        class="size-3 shrink-0 text-muted-foreground/70 transition-transform group-data-open/tool:rotate-90"
      />
    </CollapsibleTrigger>
  )
}

export function ToolContent(props: ComponentProps<typeof CollapsibleContent> & { class?: string }) {
  const rest = omit(props, 'class')
  return <CollapsibleContent {...rest} class={cn('border-t border-border/80', props.class)} />
}

type SectionProps = JSX.IntrinsicElements['div'] & { label?: string }

export function ToolSection(props: SectionProps) {
  const rest = omit(props, 'class', 'label', 'children')
  return (
    <div {...rest} class={cn('space-y-1 px-2.5 py-2', props.class)}>
      <Show when={props.label}>
        <div class="section-label">{props.label}</div>
      </Show>
      {props.children}
    </div>
  )
}

export function ToolInput(props: SectionProps & { input: unknown }) {
  const rest = omit(props, 'input')
  return (
    <ToolSection label="Arguments" {...rest}>
      <div
        class="group relative w-full overflow-hidden rounded-md border bg-terminal border-none"
        data-language="json"
      >
        <pre class="shiki m-0 overflow-auto px-3 py-2 font-mono text-[12px] leading-[1.6]">
          <HighlightedCode code={JSON.stringify(props.input, null, 2) ?? ''} language="json" />
        </pre>
      </div>
    </ToolSection>
  )
}

export function ToolOutput(props: SectionProps & { output: string; isError?: boolean }) {
  const rest = omit(props, 'output', 'isError')
  return (
    <Show when={props.output}>
      <ToolSection label={props.isError ? 'Error' : 'Output'} {...rest}>
        <pre
          class={cn(
            'max-h-80 overflow-auto rounded-sm bg-terminal px-2.5 py-2 leading-[1.55] whitespace-pre-wrap',
            props.isError ? 'text-error' : 'text-foreground/90',
          )}
        >
          <AnsiOutput output={props.output} />
        </pre>
      </ToolSection>
    </Show>
  )
}

export function ToolDiagnostics(
  props: SectionProps & {
    diagnostics: readonly { severity: 'info' | 'warn' | 'error'; message: string }[]
  },
) {
  const rest = omit(props, 'diagnostics')
  return (
    <Show when={props.diagnostics.length}>
      <ToolSection {...rest}>
        <For each={props.diagnostics} keyed={false}>
          {(diagnostic) => (
            <div
              class={cn(
                'break-words',
                diagnostic().severity === 'error'
                  ? 'text-error'
                  : diagnostic().severity === 'warn'
                    ? 'text-warning'
                    : 'text-muted-foreground',
              )}
            >
              {diagnostic().message}
            </div>
          )}
        </For>
      </ToolSection>
    </Show>
  )
}

type Image = { data: string; mimeType: string }

export function ToolImage(props: { image: Image; class?: string; alt?: string }) {
  const alt = () => props.alt ?? 'Tool result image'
  const src = () => `data:${props.image.mimeType};base64,${props.image.data}`
  return (
    <Dialog>
      <DialogTrigger
        aria-label={`Zoom ${alt()}`}
        class={cn(
          'block cursor-zoom-in overflow-hidden rounded-sm border border-border/80 bg-terminal transition-colors hover:border-brand/60',
          props.class,
        )}
      >
        <img alt={alt()} class="max-h-48 max-w-full object-contain" src={src()} />
      </DialogTrigger>
      <DialogContent
        class="w-auto max-w-[94vw] border-border/80 bg-terminal p-2 sm:max-w-[94vw]"
        showCloseButton={false}
      >
        <DialogTitle class="sr-only">{alt()}</DialogTitle>
        <img alt={alt()} class="max-h-[88vh] max-w-[90vw] object-contain" src={src()} />
      </DialogContent>
    </Dialog>
  )
}

export function ToolImages(props: SectionProps & { images: readonly Image[] }) {
  const rest = omit(props, 'images')
  return (
    <Show when={props.images.length}>
      <ToolSection
        label={props.images.length > 1 ? `${props.images.length} images` : 'Image'}
        {...rest}
      >
        <div class="flex flex-wrap gap-2">
          <For each={props.images} keyed={false}>
            {(image, index) => (
              <ToolImage
                alt={props.images.length > 1 ? `Tool result image ${index + 1}` : undefined}
                image={image()}
              />
            )}
          </For>
        </div>
      </ToolSection>
    </Show>
  )
}
