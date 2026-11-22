import { Puzzle } from '@lucide/solid'
import { Portal } from '@solidjs/web'
import { For } from 'solid-js'
import { errorMessage, ErrorReport, useExtensions, useSystem } from '../sdk/hooks.ts'
import { useProvided } from '../sdk/contribution.solid.tsx'
import { ErrorCard } from './error-card.solid.tsx'
import type { ErrorCardProps } from './error-card.solid.tsx'
import { extensionPath, stackFrames } from './error-report.ts'

export function ReportedErrorCard(props: Omit<ErrorCardProps, 'report'>) {
  const failures = (<span class="contents" />) as HTMLElement
  const report = useProvided(ErrorReport, () => null, failures)
  return (
    <>
      <ErrorCard {...props} report={report()} />
      {failures}
    </>
  )
}

export const reportedFailure = (extension: string, error: unknown, trace?: string) => (
  <ReportedErrorCard
    error={errorMessage(error)}
    extension={extension}
    stack={trace ?? stackFrames(error)}
  />
)

function StackedErrorCard(props: {
  extension: string
  footer: string
  error: string
  context?: string
  stack?: string
}) {
  const system = useSystem()
  return (
    <div class="pointer-events-auto rounded-md border border-error/30 bg-popover/95 shadow-lg backdrop-blur">
      <ReportedErrorCard
        class="border-none bg-transparent"
        context={props.context}
        error={props.error}
        extension={props.extension}
        stack={props.stack}
      />
      <div class="flex items-center gap-1.5 px-2.5 pb-2 font-mono text-[10.5px] text-muted-foreground/80">
        <Puzzle aria-hidden="true" class="size-3" />
        {extensionPath(system(), props.extension)} · {props.footer}
      </div>
    </div>
  )
}

export function ExtensionErrors(props: { stack: HTMLElement }) {
  const extensions = useExtensions()
  const failed = () => extensions().filter((record) => record.error !== undefined)
  return (
    <div class="pointer-events-none fixed top-[calc(env(safe-area-inset-top)+6rem)] right-3 z-40 flex w-96 max-w-[calc(100vw-1.5rem)] flex-col gap-2">
      <For each={failed()} keyed={(record) => record.name}>
        {(record) => (
          <StackedErrorCard
            context={
              record().extension
                ? 'the web facet did not reload; the previous version is still running'
                : 'the web facet did not load'
            }
            error={record().error ?? ''}
            extension={record().name}
            footer={record().extension ? 'previous version still running' : 'not loaded'}
          />
        )}
      </For>
      {props.stack}
    </div>
  )
}

export function StackedFailure(props: {
  stack: HTMLElement
  extension: string
  error: unknown
  trace?: string
}) {
  return (
    <Portal mount={props.stack}>
      <StackedErrorCard
        error={errorMessage(props.error)}
        extension={props.extension}
        footer="a component threw"
        stack={props.trace ?? stackFrames(props.error)}
      />
    </Portal>
  )
}
