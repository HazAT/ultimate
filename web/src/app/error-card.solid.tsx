/** @jsxImportSource @solidjs/web */
import { MessageSquareShare, TriangleAlert } from '@lucide/solid'
import { cn } from 'cn'
import { Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { useExtensions, useSystem, writerNow, writingAs } from '../sdk/hooks.ts'
import { fetchAssets, sourceFrames } from '../../../lib/source-frames.ts'
import { errorReport } from './error-report.ts'

export type Report = { title: string; send: (report: string) => void }

export type ErrorCardProps = {
  extension: string
  error: string
  context?: string
  stack?: string
  variant?: 'inline' | 'block'
  class?: string
  report?: Report
}

const reactCompatDoc = 'https://github.com/HazAT/ultimate/blob/main/docs/extensions/react-compat.md'

const reactCompatNote =
  "Ultimate's core is Solid; this React facet (web.tsx) runs on a frozen compat layer, and this part of it broke there."

function useReactFacet(extension: () => string) {
  const extensions = useExtensions()
  return () =>
    extensions().some((record) => record.name === extension() && record.framework === 'react')
}

export function ReactCompatNote(props: { extension: string }) {
  const react = useReactFacet(() => props.extension)
  return (
    <Show when={react()}>
      <div
        class="mt-1.5 font-sans text-[12px] leading-snug text-muted-foreground"
        data-react-compat
      >
        {reactCompatNote}{' '}
        <a
          class="text-foreground underline underline-offset-2 hover:text-brand"
          href={reactCompatDoc}
          rel="noreferrer"
          target="_blank"
        >
          How to move it to web.solid.tsx or keep it working with a local shim
        </a>
      </div>
    </Show>
  )
}

export function ErrorCard(props: ErrorCardProps) {
  return (
    <Show when={props.variant !== 'inline'} fallback={<InlineErrorCard {...props} />}>
      <BlockErrorCard {...props} />
    </Show>
  )
}

export function ReactCompatLink(props: { extension: string }) {
  const react = useReactFacet(() => props.extension)
  return (
    <Show when={react()}>
      <a
        aria-label={`React facet ${props.extension}: how to move it to Solid`}
        class="shrink-0 underline underline-offset-2 hover:text-foreground"
        data-react-compat
        href={reactCompatDoc}
        rel="noreferrer"
        target="_blank"
        title={reactCompatNote}
      >
        Solid core
      </a>
    </Show>
  )
}

function InlineErrorCard(props: ErrorCardProps) {
  const react = useReactFacet(() => props.extension)
  return (
    <span
      class={cn(
        'inline-flex max-w-72 items-center gap-1 rounded-sm bg-error/12 px-1.5 font-mono text-[11px] text-error',
        props.class,
      )}
      title={react() ? `${props.error}\n\n${reactCompatNote}` : props.error}
      data-extension-error={props.extension}
    >
      <TriangleAlert aria-hidden="true" class="size-3 shrink-0" />
      <span class="truncate">
        {props.extension}: {props.error}
      </span>
      <ReactCompatLink extension={props.extension} />
    </span>
  )
}

function BlockErrorCard(props: ErrorCardProps) {
  const system = useSystem()
  const send = (report: Report) => {
    const who = writerNow()
    void sourceFrames(props.stack ?? '', fetchAssets(location.origin)).then((source) =>
      writingAs(who, () =>
        report.send(
          errorReport(system(), {
            extension: props.extension,
            error: props.error,
            context: props.context ?? 'a component threw',
            stack: source || undefined,
          }),
        ),
      ),
    )
  }
  return (
    <div
      class={cn(
        'flex items-start gap-2 rounded-md border border-error/30 bg-error/8 px-2.5 py-2 font-mono text-[12px]',
        props.class,
      )}
      data-extension-error={props.extension}
    >
      <TriangleAlert aria-hidden="true" class="mt-0.5 size-3.5 shrink-0 text-error" />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 text-error">
          <span class="min-w-0 flex-1">
            extension <span class="font-semibold">{props.extension}</span> failed
          </span>
          <Show when={props.report}>
            {(report) => (
              <Button
                aria-label={`${report().title}: ${props.extension} failed`}
                class="-my-0.5 h-auto shrink-0 rounded p-0.5 font-normal text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => send(report())}
                size={null}
                title={report().title}
                variant={null}
              >
                <MessageSquareShare aria-hidden="true" class="size-3.5" />
              </Button>
            )}
          </Show>
        </div>
        <div class="mt-0.5 max-h-48 overflow-auto whitespace-pre text-muted-foreground">
          {props.error}
        </div>
        <ReactCompatNote extension={props.extension} />
      </div>
    </div>
  )
}
