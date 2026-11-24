import { RotateCw } from '@lucide/solid'
import { Errored, onSettled } from 'solid-js'
import type { JSX } from '@solidjs/web'
import { Button } from '@/components/ui/button.solid.tsx'
import { errorMessage } from '../sdk/hooks.ts'
import { ReportedErrorCard } from './error-stack.solid.tsx'
import { stackFrames } from './error-report.ts'

export function PageBoundary(props: { children: JSX.Element }) {
  return <Errored fallback={(error) => <PageFailure error={error()} />}>{props.children}</Errored>
}

function PageFailure(props: { error: unknown }) {
  onSettled(() => reportError(props.error))
  return (
    <div class="flex min-h-dvh items-center justify-center p-4">
      <div class="flex w-full max-w-xl flex-col gap-2">
        <ReportedErrorCard
          context="the page's core threw and stopped updating"
          error={errorMessage(props.error)}
          extension="core"
          stack={stackFrames(props.error)}
          title="The page stopped updating"
        />
        <Button class="self-end" onClick={() => location.reload()} size="sm" variant="outline">
          <RotateCw aria-hidden="true" class="size-3.5" />
          Reload page
        </Button>
      </div>
    </div>
  )
}
