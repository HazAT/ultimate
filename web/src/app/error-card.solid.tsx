import { MessageSquareShare, TriangleAlert } from '@lucide/solid'
import { cn } from 'cn'
import { Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { useSystem, writerNow, writingAs } from '../sdk/hooks.ts'
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

export function ErrorCard(props: ErrorCardProps) {
  return (
    <Show when={props.variant !== 'inline'} fallback={<InlineErrorCard {...props} />}>
      <BlockErrorCard {...props} />
    </Show>
  )
}

function InlineErrorCard(props: ErrorCardProps) {
  return (
    <span
      class={cn(
        'inline-flex max-w-72 items-center gap-1 rounded-sm bg-error/12 px-1.5 font-mono text-[11px] text-error',
        props.class,
      )}
      title={props.error}
      data-extension-error={props.extension}
    >
      <TriangleAlert aria-hidden="true" class="size-3 shrink-0" />
      <span class="truncate">
        {props.extension}: {props.error}
      </span>
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
      </div>
    </div>
  )
}
