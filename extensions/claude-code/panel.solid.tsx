/** @jsxImportSource @solidjs/web */
import { RefreshCw } from '@lucide/solid'
import { createEffect, createMemo, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { keepLast, refreshModels, useAction } from '@/sdk/solid'
import { StatusAction } from './refs.ts'
import type { ClaudeStatus } from './refs.ts'

function title(status: ClaudeStatus | undefined, failed: boolean) {
  if (failed) return 'Status check failed'
  if (!status?.available) return 'CLI not installed'
  if (!status.loggedIn) return 'Login not confirmed'
  return status.subscription ? 'Subscription connected' : 'CLI connected · no subscription reported'
}

export function ClaudeCodePanel() {
  const status = useAction(StatusAction, null, { onError: keepLast })
  const answer = createMemo(status.data)
  createEffect(answer, (data) => void (data && refreshModels()))
  return (
    <div class="space-y-6 p-4 text-sm">
      <div class="space-y-2 border-b pb-4">
        <p class="section-label">External provider / experimental</p>
        <h2 class="text-lg font-medium">Claude Code</h2>
        <p class="text-muted-foreground">
          Claude owns the login. Ultimate owns the conversation and tool execution.
        </p>
      </div>
      <section class="space-y-3">
        <p aria-live="polite" class="font-medium">
          {status.loading() ? 'Checking CLI…' : title(status.data(), !!status.error())}
        </p>
        <Show when={status.error()}>
          <p class="text-muted-foreground">
            Could not refresh provider availability. Try again; check the CLI in a terminal if this
            persists.
          </p>
        </Show>
        <Button
          disabled={status.loading()}
          onClick={() => status.refetch()}
          size="sm"
          variant="outline"
        >
          <RefreshCw class="size-3.5" /> Refresh Claude Code status
        </Button>
      </section>
      <section class="space-y-3">
        <h3 class="section-label">In your terminal</h3>
        <p>Install Claude Code if needed, then sign in outside Ultimate:</p>
        <pre class="overflow-x-auto rounded-md border bg-background p-3 text-xs">
          <code>
            npm install -g @anthropic-ai/claude-code{'\n'}claude auth login{'\n'}claude auth status
          </code>
        </pre>
        <p class="text-muted-foreground">
          Refresh after login, then select a Claude Code model in the model picker. An unconfirmed
          login can also mean the CLI returned an unreadable status.
        </p>
      </section>
    </div>
  )
}
