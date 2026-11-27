import { Cable, ChevronDown } from '@lucide/solid'
import { For, Match, Show, Switch, createMemo } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.solid.tsx'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control.solid.tsx'
import {
  cn,
  formatBytes,
  formatDuration,
  formatTime,
  formatTokens,
  useAction,
  useConversationId,
  useUiState,
} from '@/sdk/solid'
import { Raw, RawResponse, ReadableRequest, ReadableResponse } from './body.solid.tsx'
import { DiffView } from './diff-view.solid.tsx'
import { CallAction, ListAction } from './refs.ts'
import type { WireSummary } from './refs.ts'
import { WIRE_MODE_KEY, WIRE_PICKED_KEY, WIRE_TAB_KEY } from './state.web.ts'
import type { Picked } from './state.web.ts'

type Tab = 'request' | 'response' | 'diff'
type Mode = 'readable' | 'raw'

function CacheNumbers(props: { usage: NonNullable<WireSummary['usage']> }) {
  const warns = () =>
    props.usage.cacheWrite > props.usage.cacheRead && props.usage.cacheWrite > 1000
  return (
    <span class="tabular-nums" title="cache read · cache write · input · output tokens">
      <span class="text-muted-foreground/60">R</span> {formatTokens(props.usage.cacheRead)}{' '}
      <span class="text-muted-foreground/60">W</span>{' '}
      <span class={cn(warns() && 'text-warning/90')}>{formatTokens(props.usage.cacheWrite)}</span>{' '}
      <span class="text-muted-foreground/60">in</span> {formatTokens(props.usage.input)}{' '}
      <span class="text-muted-foreground/60">↓</span>
      {formatTokens(props.usage.output)}
    </span>
  )
}

const sizes = (call: WireSummary) =>
  `${formatBytes(call.requestBytes)}${call.responseBytes === undefined ? '' : ` → ${formatBytes(call.responseBytes)}`}`

function CallRow(props: { call: WireSummary; selected: boolean; onPick: () => void }) {
  return (
    <Button
      aria-label={`Call #${props.call.n} ${props.call.model}`}
      aria-current={props.selected ? 'true' : undefined}
      class={cn(
        'block h-auto w-full rounded-none border-0 border-l-2 border-transparent px-3 py-1.5 text-left font-mono text-[11px] font-normal hover:bg-accent/60',
        props.selected && 'border-brand bg-accent',
      )}
      onClick={() => props.onPick()}
      variant="ghost"
    >
      <span class="flex items-baseline gap-2">
        <span class="w-6 shrink-0 text-muted-foreground/70 tabular-nums">#{props.call.n}</span>
        <span class="min-w-0 flex-1 truncate text-[12px] text-foreground/90">
          {props.call.model}
        </span>
        {props.call.failure ? (
          <span class="shrink-0 text-error">failed</span>
        ) : (
          <span class="shrink-0 text-muted-foreground/70 tabular-nums">
            {formatTime(props.call.startedAt, true)}
          </span>
        )}
      </span>
      <span class="flex items-baseline gap-2 pl-8 text-muted-foreground">
        <Show when={props.call.usage}>{(usage) => <CacheNumbers usage={usage()} />}</Show>
        <span class="ml-auto shrink-0 text-muted-foreground/60">
          {formatBytes(props.call.requestBytes)}
        </span>
      </span>
    </Button>
  )
}

function Detail(props: { n: number; summary: WireSummary; calls: WireSummary[] }) {
  const call = useAction(CallAction, {
    get n() {
      return props.n
    },
  })
  const part = useUiState<Tab>(WIRE_TAB_KEY, 'request')
  const mode = useUiState<Mode>(WIRE_MODE_KEY, 'readable')
  const relay = () => props.summary.source === 'relay'
  return (
    <main class="min-w-0 flex-1 overflow-y-auto font-mono text-[11.5px]">
      <div class="sticky top-0 z-10 border-b border-border/70 bg-background/95 px-5 pt-3 pb-2.5 backdrop-blur">
        <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <span class="text-[13px] text-foreground">#{props.summary.n}</span>
          <span class="text-foreground/90">{props.summary.model}</span>
          <span>· {props.summary.provider}</span>
          <span
            class="rounded-sm border border-border/70 px-1 text-[10.5px]"
            title={
              relay()
                ? 'The HTTP exchange through Pi’s turn relay, byte for byte'
                : 'The body pi-ai built and the reply Pi assembled; no transport bytes or headers'
            }
          >
            {relay() ? 'on the wire' : 'pi-ai payload'}
          </span>
          <span>
            · {formatTime(props.summary.startedAt, true)} ·{' '}
            {formatDuration(props.summary.endedAt - props.summary.startedAt)}
          </span>
          <span>· {sizes(props.summary)}</span>
          {props.summary.status !== undefined && props.summary.status !== 200 && (
            <span class="text-error">· HTTP {props.summary.status}</span>
          )}
        </div>
        {props.summary.transport && (
          <p class="mt-1 text-[11px] text-muted-foreground/80">{props.summary.transport}</p>
        )}
        <div class="mt-2.5 flex items-center gap-2">
          <SegmentedControl aria-label="Part of the call" bind={part}>
            <SegmentedControlItem value="request">Request</SegmentedControlItem>
            <SegmentedControlItem value="response">Response</SegmentedControlItem>
            <SegmentedControlItem value="diff">Diff</SegmentedControlItem>
          </SegmentedControl>
          <Show when={part[0]() !== 'diff'}>
            <SegmentedControl aria-label="View" bind={mode}>
              <SegmentedControlItem value="readable">Readable</SegmentedControlItem>
              <SegmentedControlItem value="raw">Raw</SegmentedControlItem>
            </SegmentedControl>
          </Show>
        </div>
      </div>
      <div class="px-5 pt-4 pb-10">
        <Show
          when={part[0]() !== 'diff'}
          fallback={<DiffView call={props.summary} calls={props.calls} />}
        >
          <Show
            when={call.data()}
            fallback={
              <p class="text-muted-foreground/70">
                {call.loading() || call.data() === undefined
                  ? 'loading…'
                  : 'This call is no longer kept: Wire keeps the newest 20 per conversation.'}
              </p>
            }
          >
            {(data) => (
              <Switch>
                <Match when={part[0]() === 'request' && mode[0]() === 'raw'}>
                  <Raw text={data().request} />
                </Match>
                <Match when={part[0]() === 'request'}>
                  <ReadableRequest call={data()} />
                </Match>
                <Match when={mode[0]() === 'raw'}>
                  <RawResponse call={data()} />
                </Match>
                <Match when={true}>
                  <ReadableResponse call={data()} />
                </Match>
              </Switch>
            )}
          </Show>
        </Show>
      </div>
    </main>
  )
}

function CallMenu(props: {
  calls: WireSummary[]
  selected?: WireSummary
  onPick: (n: number) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Choose Wire call"
        class="flex h-8 w-full shrink-0 items-center gap-1.5 border-b border-border/70 bg-sidebar px-3 font-mono text-[12px] text-muted-foreground"
      >
        {props.selected
          ? `#${props.selected.n} · ${props.selected.model}`
          : `${props.calls.length} calls`}
        <ChevronDown aria-hidden="true" class="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="max-h-[60vh] w-[calc(100vw-1rem)] overflow-y-auto">
        <DropdownMenuRadioGroup
          value={props.selected ? String(props.selected.n) : undefined}
          onValueChange={(n) => props.onPick(Number(n))}
        >
          <For each={props.calls} keyed={(call) => call.n}>
            {(call) => (
              <DropdownMenuRadioItem
                class="gap-2 font-mono text-[12px]"
                closeOnSelect
                value={String(call().n)}
              >
                <span class="w-7 text-muted-foreground">#{call().n}</span>{' '}
                <span class="min-w-0 flex-1 truncate">{call().model}</span>{' '}
                <span class="text-muted-foreground">{formatTime(call().startedAt, true)}</span>
              </DropdownMenuRadioItem>
            )}
          </For>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function WireTab(props: { busy: boolean | undefined; phone: boolean }) {
  const conversationId = useConversationId()
  const list = useAction(ListAction, null, {
    on: () => props.busy,
    focus: true,
  })
  const [picked, setPicked] = useUiState<Picked | null>(WIRE_PICKED_KEY, null)
  const newestFirst = createMemo(() => list.data()?.toReversed() ?? [])
  const selected = createMemo(() => {
    const own = picked()
    const calls = list.data()
    return own && own.conversation === conversationId()
      ? calls?.find((call) => call.n === own.n)
      : calls?.at(-1)
  })
  const pick = (n: number) => {
    const conversation = conversationId()
    if (conversation !== undefined) setPicked({ conversation, n })
  }
  return (
    <div class="flex min-w-0 flex-1 flex-col">
      <div class="flex h-8 shrink-0 items-center gap-2 border-b border-border/70 px-3 font-mono text-[11px] text-muted-foreground">
        <Cable aria-hidden="true" class="size-3.5" />
        <span class="truncate">#{conversationId()} · what its model calls sent and got back</span>
      </div>
      <div class="flex min-h-0 flex-1">
        <Show
          when={list.data()}
          fallback={
            <p class="flex-1 py-10 text-center font-mono text-[11.5px] text-muted-foreground/70">
              {list.error() ? `Could not read the calls: ${list.error()?.message}` : 'loading…'}
            </p>
          }
        >
          {(calls) => (
            <Show
              when={calls().length > 0}
              fallback={
                <div class="flex-1 px-6 py-12 text-center font-mono text-[11.5px] text-muted-foreground/70">
                  <p>No calls kept for this conversation yet.</p>
                  <p class="mt-1">Its next model call shows here, request and response as sent.</p>
                </div>
              }
            >
              <Show when={!props.phone}>
                <nav
                  aria-label="Wire calls"
                  class="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-border/70 bg-sidebar"
                >
                  <div class="flex items-baseline gap-2 px-3 pt-2.5 pb-1.5">
                    <span class="section-label">calls</span>
                    <span class="font-mono text-[11px] text-muted-foreground/60">
                      {calls().length} kept · newest first
                    </span>
                  </div>
                  <For each={newestFirst()} keyed={(call) => call.n}>
                    {(call) => (
                      <CallRow
                        call={call()}
                        onPick={() => pick(call().n)}
                        selected={call().n === selected()?.n}
                      />
                    )}
                  </For>
                </nav>
              </Show>
              <div class="flex min-w-0 flex-1 flex-col">
                <Show when={props.phone}>
                  <CallMenu calls={newestFirst()} onPick={pick} selected={selected()} />
                </Show>
                <Show
                  when={selected()?.n}
                  keyed
                  fallback={
                    <p class="flex-1 px-6 py-12 text-center font-mono text-[11.5px] text-muted-foreground/70">
                      That response is no longer kept: Wire keeps the newest {calls().length} calls
                      of a conversation. Pick another call.
                    </p>
                  }
                >
                  {(n) => <Detail calls={calls()} n={n} summary={selected()!} />}
                </Show>
              </div>
            </Show>
          )}
        </Show>
      </div>
    </div>
  )
}
