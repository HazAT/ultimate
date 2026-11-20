/** @jsxImportSource @solidjs/web */
import { RefreshCw } from '@lucide/solid'
import { createEffect, createMemo, For, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { keepLast, refreshModels, useAction } from '@/sdk/solid'
import { StatusAction } from './refs.ts'
import type { AntigravityStatus } from './refs.ts'

function title(status: AntigravityStatus | undefined, failed: boolean) {
  if (failed) return 'Status check failed'
  if (!status?.available) return 'CLI not installed'
  if (!status.loggedIn) return 'Not signed in'
  return `Signed in · ${status.models.length} models`
}

export function AntigravityPanel() {
  const status = useAction(StatusAction, null, { onError: keepLast })
  const answer = createMemo(status.data)
  createEffect(answer, (data) => void (data && refreshModels()))
  return (
    <div class="space-y-6 p-4 text-sm">
      <div class="space-y-2 border-b pb-4">
        <p class="section-label">External provider / experimental</p>
        <h2 class="text-lg font-medium">Antigravity</h2>
        <p class="text-muted-foreground">
          Antigravity owns the login. Ultimate owns the conversation and tool execution.
        </p>
      </div>
      <section class="space-y-3">
        <p aria-live="polite" class="font-medium">
          {status.loading() ? 'Checking CLI…' : title(status.data(), !!status.error())}
        </p>
        <Show when={status.error()}>
          <p class="text-muted-foreground">
            Could not refresh provider availability. Try again; check `agy models` in a terminal if
            this persists.
          </p>
        </Show>
        <Show when={status.data()?.models.length}>
          <ul class="space-y-1 font-mono text-xs text-muted-foreground">
            <For each={status.data()?.models}>{(name) => <li>{name}</li>}</For>
          </ul>
        </Show>
        <Button
          disabled={status.loading()}
          onClick={() => status.refetch()}
          size="sm"
          variant="outline"
        >
          <RefreshCw class="size-3.5" /> Refresh Antigravity status
        </Button>
      </section>
      <section class="space-y-3">
        <h3 class="section-label">In your terminal</h3>
        <p>Install the Antigravity CLI if needed, then sign in outside Ultimate:</p>
        <pre class="overflow-x-auto rounded-md border bg-background p-3 text-xs">
          <code>agy{'\n'}agy models</code>
        </pre>
        <p class="text-muted-foreground">
          Refresh after signing in, then select an Antigravity model in the model picker.
        </p>
      </section>
    </div>
  )
}
