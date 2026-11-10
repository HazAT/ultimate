import { RefreshCwIcon, TerminalIcon } from 'lucide-react'
import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { defineWebExtension, refreshModels, useAction } from '@/sdk'
import { StatusAction } from './refs.ts'

function ClaudeCodePanel() {
  const { data, error, loading, refetch } = useAction(StatusAction, null, {
    onError: () => {},
  })
  useEffect(() => {
    // A successful status check also refreshes the model cache, so a login or logout reaches the picker without a reload.
    // oxlint-disable-next-line typescript/no-floating-promises -- refreshModels catches fetch failures and retries on the next system event.
    if (data) void refreshModels()
  }, [data])
  const title = loading
    ? 'Checking CLI…'
    : error
      ? 'Status check failed'
      : !data?.available
        ? 'CLI not installed'
        : !data.loggedIn
          ? 'Login not confirmed'
          : data.subscription
            ? 'Subscription connected'
            : 'CLI connected · no subscription reported'
  return (
    <div className="space-y-6 p-4 text-sm">
      <div className="space-y-2 border-b pb-4">
        <p className="section-label">External provider / experimental</p>
        <h2 className="text-lg font-medium">Claude Code</h2>
        <p className="text-muted-foreground">
          Claude owns the login. Ultimate owns the conversation and tool execution.
        </p>
      </div>
      <section className="space-y-3">
        <p aria-live="polite" className="font-medium">
          {title}
        </p>
        {error && (
          <p className="text-muted-foreground">
            Could not refresh provider availability. Try again; check the CLI in a terminal if this
            persists.
          </p>
        )}
        <Button
          className="cursor-pointer"
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => void refetch()}
        >
          <RefreshCwIcon className="size-3.5" /> Refresh status
        </Button>
      </section>
      <section className="space-y-3">
        <h3 className="section-label">In your terminal</h3>
        <p>Install Claude Code if needed, then sign in outside Ultimate:</p>
        <pre className="overflow-x-auto rounded-md border bg-background p-3 text-xs">
          <code>
            npm install -g @anthropic-ai/claude-code{'\n'}claude auth login{'\n'}claude auth status
          </code>
        </pre>
        <p className="text-muted-foreground">
          Refresh after login, then select a Claude Code model in the model picker. An unconfirmed
          login can also mean the CLI returned an unreadable status.
        </p>
      </section>
    </div>
  )
}

export default defineWebExtension({
  messages: { ja: { 'Claude Code setup…': 'Claude Code のセットアップ…' } },
  panels: [
    {
      id: 'claude-code',
      title: 'Claude Code',
      icon: TerminalIcon,
      component: ClaudeCodePanel,
      order: 10,
      // Opened from ⌘K and the model picker.
      tab: false,
    },
  ],
  commands: [
    {
      id: 'claude-code.panel',
      title: 'Claude Code setup…',
      run: (context) => context.openPanel('claude-code'),
    },
  ],
})
