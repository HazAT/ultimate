import { LoaderCircleIcon, PlugIcon, RefreshCwIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api, cn, defineWebExtension, errorMessage, provide, useAction, useNow } from '@/sdk'
import { ExtensionDetails } from '../onboarding/ui.tsx'
import { ReconnectAction, StatusAction } from './refs.ts'
import type { McpServerStatus } from './refs.ts'

/**
 * Every server's state, read again every few seconds while one is connecting, just after the next retry of a failed
 * one, and every minute otherwise.
 */
function useServers(enabled = true) {
  const status = useAction(StatusAction, null, { enabled, onError: () => {} })
  const settling = status.data?.some((server) => server.state === 'connecting') ?? false
  const now = useNow(settling ? 2_000 : 60_000)
  const retry = Math.min(...(status.data ?? []).map((server) => server.retryAt ?? Infinity))
  const { refetch } = status
  useEffect(() => {
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    if (enabled) void refetch()
  }, [enabled, now, refetch])
  useEffect(() => {
    if (!enabled || retry === Infinity) return undefined
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    const timer = setTimeout(() => void refetch(), Math.max(0, retry - Date.now()) + 500)
    return () => clearTimeout(timer)
  }, [enabled, retry, refetch])
  return status
}

const tone: Record<McpServerStatus['state'], string> = {
  connected: 'bg-success',
  connecting: 'bg-muted-foreground/50',
  failed: 'bg-error',
}

function Row({ server, onChanged }: { server: McpServerStatus; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const now = useNow(1_000, server.retryAt !== undefined)
  const reconnect = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await api.action(ReconnectAction, { name: server.name })
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
      onChanged()
    }
  }
  const retry = server.retryAt && Math.max(0, Math.ceil((server.retryAt - now) / 1000))
  return (
    <li className="px-2 py-1.5" data-mcp-server={server.name} data-state={server.state}>
      <div className="flex items-center gap-2 text-[12px]">
        <span className={cn('size-1.5 shrink-0 rounded-full', tone[server.state])} />
        <span className="min-w-0 truncate text-foreground/90">{server.name}</span>
        <span className="shrink-0 text-[10.5px] text-muted-foreground/70">
          {server.transport}
          {server.source === 'project' && ' · project'}
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
          {server.state === 'connected'
            ? `${server.tools} ${server.tools === 1 ? 'tool' : 'tools'}`
            : server.state}
        </span>
        <button
          aria-label={`Reconnect ${server.name}`}
          className="-mr-1 rounded-sm p-0.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          disabled={busy || server.state === 'connecting'}
          onClick={() => void reconnect()}
          title="Reconnect"
          type="button"
        >
          {busy || server.state === 'connecting' ? (
            <LoaderCircleIcon className="size-3 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3" />
          )}
        </button>
      </div>
      {(server.error || error) && (
        <p className="mt-0.5 line-clamp-3 pl-3.5 text-[11px] leading-snug break-words text-error/85">
          {error ?? server.error}
          {retry !== undefined && !error && (
            <span className="text-muted-foreground/70"> · retry in {retry}s</span>
          )}
        </p>
      )}
    </li>
  )
}

function Servers({ servers, onChanged }: { servers: McpServerStatus[]; onChanged: () => void }) {
  return (
    <ul className="flex flex-col font-mono">
      {servers.map((server) => (
        <Row key={server.name} onChanged={onChanged} server={server} />
      ))}
    </ul>
  )
}

/**
 * "mcp 2/3" in the status line: connected out of configured servers, red while one failed. Hidden while none is
 * configured; the popover lists each server with its state, tool count and a reconnect button.
 */
function Chip() {
  const { data: servers, refetch } = useServers()
  if (!servers?.length) return null
  const connected = servers.filter((server) => server.state === 'connected').length
  const failed = servers.some((server) => server.state === 'failed')
  const refresh = () => void refetch()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label="MCP servers"
          className={cn(
            '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground',
            failed && 'text-error',
          )}
          data-mcp={failed ? 'failed' : connected === servers.length ? 'connected' : 'connecting'}
          type="button"
        >
          <PlugIcon className="size-3" />
          mcp {connected}/{servers.length}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-1rem)] p-1" side="top">
        <Servers onChanged={refresh} servers={servers} />
        <p className="border-t border-border/70 px-2 pt-1.5 pb-1 font-mono text-[11px] text-muted-foreground/70">
          mcpServers in ~/.ultimate/settings.json or the project's .ultimate/settings.json
        </p>
      </PopoverContent>
    </Popover>
  )
}

/** The server list under the mcp row of the Extensions panel. */
function useDetails(name: string) {
  const { data: servers, refetch } = useServers(name === 'mcp')
  if (name !== 'mcp') return null
  if (!servers?.length)
    return <p className="text-muted-foreground/70">no servers: add mcpServers to settings.json</p>
  return <Servers onChanged={() => void refetch()} servers={servers} />
}

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: Chip, order: -2 }] },
  provides: [provide(ExtensionDetails, useDetails)],
})
