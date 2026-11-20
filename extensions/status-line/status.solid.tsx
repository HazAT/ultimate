/** @jsxImportSource @solidjs/web */
import type { JSX } from '@solidjs/web'
import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
import {
  ROOT,
  cn,
  elidePath,
  formatTime,
  formatTokens,
  api,
  shortenPath,
  useConnection,
  useConversation,
  useConversations,
  useDoc,
  useDocOf,
  useModels,
  useSystem,
} from '@/sdk/solid'
import type { Usage } from '@/sdk'
import { lastAssistant, promptTokens } from '../../lib/context-usage.ts'
import { ContextDoc } from '../conversations/refs.ts'
import { WorkspacesDoc } from '../workspaces/refs.ts'
import { usageTotals } from './context.ts'
import { deadline, retryAfter } from '../../lib/timers.ts'
import type { Cancel } from '../../lib/timers.ts'
import { RatesAction } from './refs.ts'
import type { RateSample } from './refs.ts'

function Item(props: { name: string; tip: JSX.Element; class?: string; children: JSX.Element }) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={props.name}
        class={cn('flex items-center gap-1.5', props.class)}
        render={(trigger) => <span {...trigger} />}
      >
        {props.children}
      </TooltipTrigger>
      <TooltipContent class="font-mono text-[11px]" side="top">
        {props.tip}
      </TooltipContent>
    </Tooltip>
  )
}

export function Cwd() {
  const system = useSystem()
  const conversation = useConversation()
  const workspaces = useDocOf(() => ROOT, WorkspacesDoc)
  const workspace = () => workspaces()?.items[String(conversation().id)]
  return (
    <Show when={system()}>
      {(info) => {
        const cwd = () => conversation().agent.cwd ?? info().execution.defaultCwd
        const inRepo = () => !workspace() && cwd() === info().code.ultimateRoot
        const branch = () => (inRepo() ? info().code.branch : undefined)
        return (
          <Item
            class="min-w-0 overflow-hidden text-foreground/80"
            name="Working directory"
            tip={
              <>
                {workspace()?.path ?? cwd()}
                <Show when={workspace()}>{(shown) => <div>{shown().branch}</div>}</Show>
                <Show when={branch()}>
                  <div>
                    {branch()} @ {info().code.sha}
                    {info().code.dirty ? ' · uncommitted changes' : ''}
                  </div>
                </Show>
              </>
            }
          >
            <span class="truncate">
              {elidePath(
                workspace()
                  ? `#${conversation().id}`
                  : shortenPath(cwd(), { home: info().machine.home }),
                40,
              )}
            </span>
            <Show when={branch()}>
              <span class="max-w-96 shrink-[9] truncate text-muted-foreground">
                ({branch()}
                <Show when={info().code.dirty}>
                  <span class="text-warning">*</span>
                </Show>
                )
              </span>
            </Show>
          </Item>
        )
      }}
    </Show>
  )
}

function UsageRows(props: { buckets: Record<string, Usage>; prefix?: string }) {
  return (
    <For each={Object.entries(props.buckets)}>
      {([label, bucket]) => (
        <>
          <span>
            {props.prefix}
            {label}
          </span>
          <span class="text-right">
            ↑{formatTokens(bucket.input)} ↓{formatTokens(bucket.output)} $
            {bucket.cost.total.toFixed(4)}
          </span>
        </>
      )}
    </For>
  )
}

export function Tokens() {
  const conversation = useConversation()
  const models = useModels()
  const parts = createMemo(() => {
    const { usage, entries, agent } = conversation()
    const total = usageTotals(usage)
    const latest = lastAssistant(entries).message?.usage
    const subscription = !!models()?.providers.find(
      (provider) => provider.id === agent.model?.provider,
    )?.isUsingSubscription
    const counts = [
      total.input && `↑${formatTokens(total.input)}`,
      total.output && `↓${formatTokens(total.output)}`,
      total.cacheRead && `R${formatTokens(total.cacheRead)}`,
      total.cacheWrite && `W${formatTokens(total.cacheWrite)}`,
      (total.cacheRead > 0 || total.cacheWrite > 0) &&
        latest &&
        promptTokens(latest) > 0 &&
        `CH${((latest.cacheRead / promptTokens(latest)) * 100).toFixed(1)}%`,
    ].filter((part) => typeof part === 'string')
    const spend = total.cost > 0 || (subscription && counts.length > 0)
    return { counts, cost: spend ? `$${total.cost.toFixed(3)}` : undefined, subscription }
  })
  return (
    <Show when={parts().counts.length > 0 || parts().cost}>
      <Item
        class="max-md:hidden"
        name="Conversation usage"
        tip={
          <div class="grid grid-cols-[auto_auto] gap-x-3">
            <UsageRows buckets={conversation().usage.models} />
            <UsageRows buckets={conversation().usage.tools} prefix="tool " />
          </div>
        }
      >
        <For each={parts().counts}>{(part) => <span>{part}</span>}</For>
        <Show when={parts().cost}>
          <span class="text-foreground/80">
            {parts().cost}
            <Show when={parts().subscription}>
              <span class="text-muted-foreground"> (sub)</span>
            </Show>
          </span>
        </Show>
      </Item>
    </Show>
  )
}

export function Context() {
  const context = useDoc(ContextDoc)
  return (
    <Show when={context()?.window}>
      {(window) => {
        const percent = () => context()?.percent
        const used = () => context()?.tokens
        const estimated = () => context()?.estimated
        return (
          <Item
            name="Context use"
            class={cn(
              (percent() ?? 0) > 90 ? 'text-error' : (percent() ?? 0) > 70 && 'text-warning',
            )}
            tip={
              used() === undefined
                ? 'Context size is known after the next response'
                : `${estimated() ? 'About ' : ''}${used()!.toLocaleString()} of ${window().toLocaleString()} tokens in context${estimated() ? ', estimated until the next response' : ''}`
            }
          >
            <span class="relative h-1.5 w-8 overflow-hidden rounded-full bg-muted">
              <span
                class="absolute inset-y-0 left-0 rounded-full bg-current opacity-70"
                style={{ width: `${Math.min(100, percent() ?? 0)}%` }}
              />
            </span>
            {percent() === undefined ? '?' : `${percent()!.toFixed(1)}%`}/{formatTokens(window())}
          </Item>
        )
      }}
    </Show>
  )
}

function useRates() {
  const connection = useConnection()
  const system = useSystem()
  const [sample, setSample] = createSignal<RateSample | null>(null)
  const session = createMemo(() =>
    connection().status === 'open' ? system()?.process.generation : undefined,
  )
  createEffect(session, (generation) => {
    setSample(null)
    if (generation === undefined) return undefined
    let request: AbortController | undefined
    let cancel: Cancel | undefined
    const poll = async () => {
      const own = (request = new AbortController())
      const expire = deadline(5000, () => own.abort())
      const next = await api.action(RatesAction, null, { signal: own.signal }).catch(() => null)
      expire()
      if (request !== own) return
      setSample(own.signal.aborted ? null : next)
      cancel = retryAfter(1000, () => void poll())
    }
    void poll()
    return () => {
      request?.abort()
      request = undefined
      cancel?.()
    }
  })
  return sample
}

export function GlobalUsage() {
  const sample = useRates()
  const rate = (pick: (value: NonNullable<ReturnType<typeof sample>>) => number) => {
    const value = sample()
    return value ? pick(value).toFixed(1) : '?'
  }
  const total = (pick: (value: NonNullable<ReturnType<typeof sample>>) => string) => {
    const value = sample()
    return value ? pick(value) : '?'
  }
  const conversations = useConversations()
  const running = () => conversations().filter((conversation) => conversation.busy).length
  return (
    <>
      <Item
        name="Token rate and running agents"
        tip={
          <>
            <div>
              Input ↑{rate((value) => value.rates.input)} · Output ↓
              {rate((value) => value.rates.output)}
            </div>
            <div>
              Cache read {rate((value) => value.rates.cacheRead)} · Cache write{' '}
              {rate((value) => value.rates.cacheWrite)}
            </div>
            <div class="mt-1 max-w-72">
              Model tokens per second across all conversations, averaged over the last 30 seconds.
              Provider reports may arrive late, and tool usage is excluded.
            </div>
            <div class="mt-1 max-w-72">
              Running agents across all conversations in this project, including subagents.
            </div>
          </>
        }
      >
        <span aria-label="Output token rate">
          ↓{total((value) => String(Math.round(value.rates.output)))} tok/s
        </span>
        <span aria-label="Running agents" class="tabular-nums">
          {running()} {running() === 1 ? 'agent' : 'agents'}
        </span>
      </Item>
      <Item name="Project spend" tip="Tokens and cost across all conversations in this project">
        <span aria-label="Global spend">
          ↑{total((value) => formatTokens(value.totals.input))} ↓
          {total((value) => formatTokens(value.totals.output))} $
          {total((value) => value.totals.cost.toFixed(3))}
        </span>
      </Item>
    </>
  )
}

export function Connection() {
  const connection = useConnection()
  const system = useSystem()
  const open = () => connection().status === 'open'
  return (
    <Item
      name="Server connection"
      tip={
        <Show when={system()} fallback="Waiting for the server">
          {(info) => (
            <>
              {info().process.url} · pid {info().process.pid} · node {info().process.node}
              <div>
                generation {info().process.generation} · since{' '}
                {formatTime(info().process.startedAt, true)}
              </div>
            </>
          )}
        </Show>
      }
    >
      <span
        class={cn('size-1.5 rounded-full', open() ? 'bg-success' : 'animate-pulse-dot bg-warning')}
      />
      <span class={cn(!open() && 'text-warning')}>
        {open() ? 'live' : connection().status === 'connecting' ? 'connecting…' : 'reconnecting…'}
      </span>
      <Show when={system()}>
        {(info) => <span class="text-muted-foreground/70">gen {info().process.generation}</span>}
      </Show>
    </Item>
  )
}
