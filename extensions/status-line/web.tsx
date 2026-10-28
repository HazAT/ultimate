import { useEffect, useState, type ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  api,
  cn,
  defineWebExtension,
  elidePath,
  formatDuration,
  formatTime,
  formatTokens,
  shortenPath,
  useConnection,
  useConversation,
  useConversations as useAllConversations,
  useModels,
  useSystem,
  useDoc,
  useTranscript,
} from '@/sdk'
import type { AssistantMessage, EntryRecord, Usage } from '@/sdk'
import { useWorkspaceConversations as useConversations } from '../workspaces/ui.tsx'
import { ContextDoc } from '../conversations/ui.tsx'
import { ModelLabel } from '../models/ui.tsx'
import { lastAssistant, promptTokens as prompt } from '../../lib/context-usage.ts'
import { usageTotals } from './context.ts'
import { RatesAction } from './refs.ts'
import type { RateSample } from './refs.ts'
import { responseAfter, turnOf } from './turns.ts'

/** A status-line item with a tooltip of details. */
function Item({
  children,
  tip,
  className,
}: {
  children: ReactNode
  tip?: ReactNode
  className?: string
}) {
  const content = <span className={cn('flex items-center gap-1.5', className)}>{children}</span>
  if (!tip) return content
  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent className="font-mono text-[11px]" side="top">
        {tip}
      </TooltipContent>
    </Tooltip>
  )
}

function Cwd() {
  const system = useSystem()
  const { agent, id } = useConversation()
  const workspace = useConversations().find((conversation) => conversation.id === id)?.workspace
  if (!system) return null
  const cwd = agent.cwd ?? system.execution.defaultCwd
  const shown = workspace ? `#${id}` : shortenPath(cwd, { home: system.machine.home })
  const { branch, dirty, sha } = system.code
  const inRepo = !workspace && cwd === system.code.ultimateRoot
  return (
    <Item
      className="min-w-0 overflow-hidden text-foreground/80"
      tip={
        <>
          {workspace?.path ?? cwd}
          {workspace && <div>{workspace.branch}</div>}
          {inRepo && branch && (
            <div>
              {branch} @ {sha}
              {dirty ? ' · uncommitted changes' : ''}
            </div>
          )}
        </>
      }
    >
      <span className="truncate">{elidePath(shown, 40)}</span>
      {inRepo && branch && (
        <span className="max-w-96 shrink-[9] truncate text-muted-foreground">
          ({branch}
          {dirty && <span className="text-warning">*</span>})
        </span>
      )}
    </Item>
  )
}

function useTokenRates() {
  const connection = useConnection()
  const system = useSystem()
  const generation = system?.process.generation
  const key = `${connection.status}:${connection.since}:${generation}`
  const [observed, setObserved] = useState<{ key: string; sample: RateSample | null }>()
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let requestTimeout: ReturnType<typeof setTimeout> | undefined
    let request: AbortController | undefined
    setObserved({ key, sample: null })
    if (connection.status !== 'open' || generation === undefined) return undefined
    async function poll() {
      request = new AbortController()
      requestTimeout = setTimeout(() => request?.abort(), 5000)
      try {
        const sample = await api.action(RatesAction, null, {
          signal: request.signal,
        })
        request.signal.throwIfAborted()
        if (!cancelled) setObserved({ key, sample })
      } catch {
        if (!cancelled) {
          setObserved({ key, sample: null })
        }
      } finally {
        clearTimeout(requestTimeout)
        if (!cancelled) timer = setTimeout(poll, 1000)
      }
    }
    // oxlint-disable-next-line typescript/no-floating-promises -- poll catches failures and clears the sample until the next poll.
    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
      clearTimeout(requestTimeout)
      request?.abort()
    }
  }, [key, connection.status, generation])
  return observed?.key === key ? observed.sample : null
}

function Tokens() {
  const { usage, entries, agent } = useConversation()
  const models = useModels()
  const total = usageTotals(usage)
  const latest = lastAssistant(entries).message?.usage
  const hit =
    (total.cacheRead > 0 || total.cacheWrite > 0) && latest && prompt(latest) > 0
      ? (latest.cacheRead / prompt(latest)) * 100
      : undefined
  const subscription = !!models?.providers.find((provider) => provider.id === agent.model?.provider)
    ?.isUsingSubscription
  const parts: ReactNode[] = []
  if (total.input) parts.push(`↑${formatTokens(total.input)}`)
  if (total.output) parts.push(`↓${formatTokens(total.output)}`)
  if (total.cacheRead) parts.push(`R${formatTokens(total.cacheRead)}`)
  if (total.cacheWrite) parts.push(`W${formatTokens(total.cacheWrite)}`)
  if (hit !== undefined) parts.push(`CH${hit.toFixed(1)}%`)
  // A subscription's $0.000 says something once there is usage, and looks broken before.
  if (total.cost || (subscription && parts.length > 0))
    parts.push(
      <span className="text-foreground/80">
        ${total.cost.toFixed(3)}
        {subscription && <span className="text-muted-foreground"> (sub)</span>}
      </span>,
    )
  if (!parts.length) return null
  return (
    <Item
      // On a phone the status line below already sums the usage.
      className="max-md:hidden"
      tip={
        <>
          <div className="grid grid-cols-[auto_auto] gap-x-3">
            {Object.entries(usage.models).map(([model, bucket]) => (
              <ModelRow bucket={bucket} key={model} label={model} />
            ))}
            {Object.entries(usage.tools).map(([tool, bucket]) => (
              <ModelRow bucket={bucket} key={tool} label={`tool ${tool}`} />
            ))}
          </div>
        </>
      }
    >
      {parts.map((part, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- Positional usage fragments built for this render.
        <span key={index}>{part}</span>
      ))}
    </Item>
  )
}

function GlobalUsage() {
  const speed = useTokenRates()
  const running = useAllConversations().filter((conversation) => conversation.busy).length
  return (
    <>
      <Item
        tip={
          <>
            <div>
              Input ↑{speed ? speed.rates.input.toFixed(1) : '?'} · Output ↓
              {speed ? speed.rates.output.toFixed(1) : '?'}
            </div>
            <div>
              Cache read {speed ? speed.rates.cacheRead.toFixed(1) : '?'} · Cache write{' '}
              {speed ? speed.rates.cacheWrite.toFixed(1) : '?'}
            </div>
            <div className="mt-1 max-w-72">
              Model tokens per second across all conversations, averaged over the last 30 seconds.
              Provider reports may arrive late, and tool usage is excluded.
            </div>
            <div className="mt-1 max-w-72">
              Running agents across all conversations in this project, including subagents.
            </div>
          </>
        }
      >
        <span aria-label="Output token rate">
          ↓{speed ? Math.round(speed.rates.output) : '?'} tok/s
        </span>
        <span aria-label="Running agents" className="tabular-nums">
          {running} {running === 1 ? 'agent' : 'agents'}
        </span>
      </Item>
      <Item tip="Tokens and cost across all conversations in this project">
        <span aria-label="Global spend">
          ↑{speed ? formatTokens(speed.totals.input) : '?'} ↓
          {speed ? formatTokens(speed.totals.output) : '?'} $
          {speed ? speed.totals.cost.toFixed(3) : '?'}
        </span>
      </Item>
    </>
  )
}

function ModelRow({ label, bucket }: { label: string; bucket: Usage }) {
  return (
    <>
      <span>{label}</span>
      <span className="text-right">
        ↑{formatTokens(bucket.input)} ↓{formatTokens(bucket.output)} ${bucket.cost.total.toFixed(4)}
      </span>
    </>
  )
}

function Context() {
  const { tokens: used, window, percent, estimated } = useDoc(ContextDoc) ?? {}
  if (!window) return null
  return (
    <Item
      className={cn(
        percent !== undefined && percent > 90
          ? 'text-error'
          : percent !== undefined && percent > 70
            ? 'text-warning'
            : undefined,
      )}
      tip={
        used === undefined
          ? 'Context size is known after the next response'
          : `${estimated ? 'About ' : ''}${used.toLocaleString()} of ${window.toLocaleString()} tokens in context${estimated ? ', estimated until the next response' : ''}`
      }
    >
      <span className="relative h-1.5 w-8 overflow-hidden rounded-full bg-muted">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-current opacity-70"
          style={{ width: `${Math.min(100, percent ?? 0)}%` }}
        />
      </span>
      {percent === undefined ? '?' : `${percent.toFixed(1)}%`}/{formatTokens(window)}
    </Item>
  )
}

const dollars = (cost: number) => `$${cost.toFixed(cost < 1 ? 3 : 2)}`

/**
 * A stored message's readout on its hover row: the context its response was sent with, and what it cost. A turn's
 * last response adds up the turn since its input; an input shows the context it was sent into.
 */
function MessageUsage({ entry }: { entry: EntryRecord }) {
  const entries = useTranscript()
  const models = useModels()
  const stored = entry.model?.[0]
  const input = stored?.role === 'user'
  const message: AssistantMessage | undefined =
    stored?.role === 'assistant' ? stored : input ? responseAfter(entries, entry) : undefined
  if (!message) return null
  const used = prompt(message.usage)
  if (used === 0) return null
  const window = models?.models.find(
    (model) => model.provider === message.provider && model.id === message.model,
  )?.contextWindow
  const context = window
    ? `${((used / window) * 100).toFixed(1)}% ctx`
    : `${formatTokens(used)} ctx`
  const contextTip = `${used.toLocaleString()}${window ? ` of ${window.toLocaleString()}` : ''} tokens`
  if (input) return <Item tip={<>Sent into a context of {contextTip}</>}>{context}</Item>
  const ended = message.stopReason !== 'toolUse'
  const turn = ended ? turnOf(entries, entry) : undefined
  const many = turn && turn.responses > 1 ? turn : undefined
  const end = message.timestamp + (message.durationMs ?? 0)
  const cost = many ? many.cost : message.usage.cost.total
  const parts = [
    ...(ended ? [message.model] : []),
    context,
    ...(many ? [`turn ${formatDuration(end - many.started)}`] : []),
    ...(cost > 0 ? [dollars(cost)] : []),
  ]
  return (
    <Item
      className="min-w-0"
      tip={
        <div className="grid grid-cols-[auto_auto] gap-x-3">
          <span>Response</span>
          <span>
            ↑{formatTokens(used)} ↓{formatTokens(message.usage.output)} ·{' '}
            {dollars(message.usage.cost.total)}
            {message.durationMs ? ` · ${formatDuration(message.durationMs)}` : ''}
          </span>
          {many && (
            <>
              <span>Turn</span>
              <span>
                {many.responses} responses · ↑{formatTokens(many.prompt)} ↓
                {formatTokens(many.output)} · {dollars(many.cost)} ·{' '}
                {formatDuration(end - many.started)}
              </span>
            </>
          )}
          <span>Context</span>
          <span>{contextTip}</span>
          <span>Model</span>
          <span>
            <ModelLabel
              model={`${message.provider}/${message.model}`}
              thinking={message.thinkingLevel ?? message.providerThinkingLevel}
            />
            {(message.thinkingLevel ?? message.providerThinkingLevel) &&
              ` · ${message.thinkingLevel ?? message.providerThinkingLevel}`}
          </span>
        </div>
      }
    >
      <span className="truncate">{parts.join(' · ')}</span>
    </Item>
  )
}

function Connection() {
  const connection = useConnection()
  const system = useSystem()
  const open = connection.status === 'open'
  return (
    <Item
      tip={
        system && (
          <>
            {system.process.url} · pid {system.process.pid} · node {system.process.node}
            <div>
              generation {system.process.generation} · since{' '}
              {formatTime(system.process.startedAt, true)}
            </div>
          </>
        )
      }
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          open ? 'bg-success' : 'animate-pulse-dot bg-warning',
        )}
      />
      <span className={open ? undefined : 'text-warning'}>
        {open ? 'live' : connection.status === 'connecting' ? 'connecting…' : 'reconnecting…'}
      </span>
      {system && <span className="text-muted-foreground/70">gen {system.process.generation}</span>}
    </Item>
  )
}

export default defineWebExtension({
  messageDetails: [MessageUsage],
  slots: {
    'composer.status': [Cwd, Tokens, Context],
    'statusline.left': [GlobalUsage],
    'statusline.right': [{ component: Connection, phone: true }],
  },
})
