import { Flame, X } from '@lucide/solid'
import { For, Show, createMemo } from 'solid-js'
import type { ConversationId } from '@earendil-works/pi-durable'
import { Button } from '@/components/ui/button.solid.tsx'
import { NumberInput } from '@/components/ui/number-input.solid.tsx'
import { Popover, PopoverContent } from '@/components/ui/popover.solid.tsx'
import { StatusPopoverTrigger } from '@/components/ui/status-trigger.solid.tsx'
import { Switch } from '@/components/ui/switch.solid.tsx'
import {
  ROOT,
  api,
  cn,
  events,
  formatAgo,
  keepLast,
  useAction,
  useConversationId,
  useConversations,
  useDocOf,
  useNow,
} from '@/sdk/solid'
import { StandingDoc } from '../subagents/refs.ts'
import { duration } from './duration.shared.ts'
import { SetAction, StateAction, WarmDoc } from './refs.ts'
import type { Setting, Source, WarmState } from './refs.ts'

const tokens = (count = 0) => (count >= 1000 ? `${Math.round(count / 1000)}k` : String(count))

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const failed = (state: WarmState) =>
  state.last?.error !== undefined && (state.lastAt === undefined || state.last.at >= state.lastAt)

const isWarm = (state: WarmState, now: number) =>
  state.lastAt !== undefined && state.ttl !== undefined && state.lastAt + state.ttl > now

const dollars = (amount: number) => `$${amount < 1 ? amount.toFixed(3) : amount.toFixed(2)}`

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

function lifetimeLines(state: WarmState) {
  if (state.ttl === undefined) return ['Cache lifetime unknown: not warmed']
  return [
    `Cache lasts ${duration(state.ttl)} · ${tokens(state.tokens)} context`,
    ...(state.rewriteCost === undefined
      ? []
      : [`Writing it again costs ≈ ${dollars(state.rewriteCost)}`]),
  ]
}

function warmCostLine(state: WarmState) {
  if (!state.warmCost?.pings) return undefined
  const { pings, cost } = state.warmCost
  return `≈ ${dollars(cost)} for ${plural(pings, 'ping')}, one every ${duration(state.pingAfter ?? 0)}`
}

function statusLines(state: WarmState, now: number) {
  const lines: string[] = []
  if (state.lastAt !== undefined && state.ttl !== undefined) {
    const expires = state.lastAt + state.ttl
    lines.push(expires > now ? `Runs out ${clock(expires)}` : `Cold since ${clock(expires)}`)
  }
  if (state.next)
    lines.push(
      `${state.next.step === 'ping' ? 'Next ping' : 'Compacts'} ${clock(Math.max(now, state.next.at))}${state.running ? ' (in a run)' : ''}`,
    )
  else if (state.warm.value || state.compact.value) lines.push(state.idle ?? 'Nothing due')
  if (state.warmUntil !== undefined && state.warmUntil > now)
    lines.push(`Warm until ${clock(state.warmUntil)}`)
  return lines
}

function Tag(props: { source: Source }) {
  return (
    <span
      class={cn(
        'w-14 shrink-0 text-right text-[10px] text-amber-500/80',
        props.source !== 'override' && 'invisible',
      )}
      data-source={props.source}
      title="Set for this chat only; reset goes back to the default"
    >
      this chat
    </span>
  )
}

function Reset(props: { label: string; shown: boolean; onReset: () => void }) {
  return (
    <Button
      aria-label={`Reset ${props.label}`}
      class={cn(
        'size-4 rounded-sm text-muted-foreground/60 hover:bg-accent hover:text-foreground',
        !props.shown && 'invisible',
      )}
      onClick={() => props.onReset()}
      size={null}
      title="Back to the agent's setting"
      variant={null}
    >
      <X class="size-3" />
    </Button>
  )
}

function SwitchRow(props: {
  label: string
  name: string
  setting: Setting<boolean>
  onChange: (value: boolean | null) => void
}) {
  return (
    <div class="flex h-8 items-center gap-2 px-2 text-[12px]">
      <label class="flex flex-1 items-center gap-2">
        <span class="flex-1">{props.label}</span>
        <Tag source={props.setting.source} />
        <Switch
          aria-label={props.name}
          bind={[() => props.setting.value, (on) => props.onChange(on)]}
        />
      </label>
      <Reset
        label={props.name}
        onReset={() => props.onChange(null)}
        shown={props.setting.source === 'override'}
      />
    </div>
  )
}

function MinutesRow(props: {
  name: string
  setting: Setting<number>
  onSave: (value: number | null) => void
}) {
  const label = () => `Keep ${props.name} warm for, in minutes`
  const commit = (value: number | null) => {
    if (value !== null && value !== props.setting.value) props.onSave(value)
  }
  return (
    <div class="flex h-7 items-center gap-2 px-2 text-[11.5px]">
      <span class="text-muted-foreground">Warm for</span>
      <NumberInput
        aria-label={label()}
        class="h-5 w-14 text-right text-foreground"
        format={{ useGrouping: false }}
        min={0}
        onValueChange={(next, details) => {
          if (details.source === 'agent') commit(next)
        }}
        onValueCommit={commit}
        value={props.setting.value}
      />
      <span class="flex-1 text-muted-foreground/70">min</span>
      <Tag source={props.setting.source} />
      <Reset
        label={label()}
        onReset={() => props.onSave(null)}
        shown={props.setting.source === 'override'}
      />
    </div>
  )
}

function Popup(props: { id: ConversationId; name: string; state: WarmState; refresh: () => void }) {
  const now = useNow(30_000)
  const set = (change: {
    warm?: boolean | null
    compact?: boolean | null
    minutes?: number | null
  }) =>
    api
      .action(SetAction, { id: props.id, ...change })
      .then(props.refresh)
      .catch((error: unknown) => console.warn('Keep warm', error))
  const on = () => props.state.warm.value || props.state.compact.value
  const kept = () =>
    props.state.kept &&
    `Kept warm so far: ${dollars(props.state.kept.cost)} (${plural(props.state.kept.pings, 'ping')})`
  return (
    <PopoverContent align="end" class="w-80 p-1 font-mono" side="top">
      <div
        class="px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground"
        title={props.state.provider ? `${props.state.provider}/${props.state.model}` : undefined}
      >
        <For each={lifetimeLines(props.state)}>{(line) => <div>{line}</div>}</For>
      </div>
      <SwitchRow
        label={`Keep ${props.name} warm`}
        name={`Keep ${props.name} warm`}
        onChange={(warm) => void set({ warm })}
        setting={props.state.warm}
      />
      <Show when={on()}>
        <MinutesRow
          name={props.name}
          onSave={(minutes) => void set({ minutes })}
          setting={props.state.minutes}
        />
      </Show>
      <Show when={props.state.warm.value && warmCostLine(props.state)}>
        {(line) => (
          <div class="px-2 pb-1 text-[11px] text-muted-foreground" data-warm-cost>
            {line()}
          </div>
        )}
      </Show>
      <Show when={props.state.kind === 'coordinator'}>
        <SwitchRow
          label="Compact before cold"
          name={`Compact ${props.name} before cold`}
          onChange={(compact) => void set({ compact })}
          setting={props.state.compact}
        />
      </Show>
      <div class="space-y-1 border-t border-border/70 px-2 pt-1.5 pb-1.5 text-[11px] text-muted-foreground">
        <div class="text-foreground/80">
          <Show when={statusLines(props.state, now()).length} fallback="Off">
            <For each={statusLines(props.state, now())}>{(line) => <div>{line}</div>}</For>
          </Show>
        </div>
        <Show when={kept()}>{(line) => <div>{line()}</div>}</Show>
        <Show when={props.state.last}>
          {(last) => (
            <div class={cn(failed(props.state) && 'text-red-500')}>
              Last ping {formatAgo(last().at)}
              {last().error !== undefined
                ? `: ${last().error}`
                : ` · read ${tokens(last().read)}, wrote ${tokens(last().write)}`}
            </div>
          )}
        </Show>
        <Show when={props.state.compaction}>
          {(compaction) => (
            <div class={cn(compaction().error !== undefined && 'text-red-500')}>
              Compacted {clock(compaction().at)} · was {tokens(compaction().tokens)}
              {compaction().error !== undefined
                ? `: ${compaction().error}`
                : compaction().read !== undefined
                  ? ` · read ${tokens(compaction().read)}, wrote ${tokens(compaction().write)}`
                  : ''}
            </div>
          )}
        </Show>
        <Show when={props.state.agent}>
          {(agent) => (
            <Button
              class="h-auto p-0 font-[family-name:inherit] text-[length:inherit] font-normal text-foreground/80 underline-offset-2 hover:underline"
              onClick={() => events.emit('subagents:open-definition', { name: agent() })}
              size={null}
              variant={null}
            >
              Defaults from Agents › {agent()}
            </Button>
          )}
        </Show>
      </div>
    </PopoverContent>
  )
}

function chip(id: ConversationId, label: string, name: string) {
  const doc = useDocOf(() => id, WarmDoc)
  const conversations = useConversations()
  const answerAt = createMemo(() => conversations().find((row) => row.id === id)?.answerAt)
  const { data, refetch } = useAction(
    StateAction,
    { id },
    { conversation: id, onError: keepLast, on: () => [doc(), answerAt()], every: 30_000 },
  )
  const now = useNow(30_000)
  const props = { id, label, name }
  return (
    <Show when={data()?.kind && data()}>
      {(state) => {
        const on = () => state().warm.value || state().compact.value
        const warm = () => isWarm(state(), now())
        return (
          <Popover onOpenChange={(open) => open && void refetch()}>
            <StatusPopoverTrigger
              aria-label={`${props.name}'s prompt cache`}
              class={cn(!on() && 'text-muted-foreground/60')}
              data-keep-warm={on() ? (warm() ? 'warm' : 'cold') : 'off'}
            >
              <Flame
                class={cn(
                  'size-3',
                  on() && warm() && 'text-amber-500',
                  (failed(state()) || state().compaction?.error !== undefined) && 'text-red-500',
                )}
              />
              {props.label}
            </StatusPopoverTrigger>
            <Popup id={props.id} name={props.name} refresh={() => void refetch()} state={state()} />
          </Popover>
        )
      }}
    </Show>
  )
}

export function UltimateChip() {
  const standing = useDocOf(() => ROOT, StandingDoc)
  return (
    <Show keyed when={standing()?.ultimate}>
      {(id) => chip(id, '@ultimate', '@ultimate')}
    </Show>
  )
}

export function BranchChip() {
  const shown = useConversationId()
  const conversations = useConversations()
  const coordinator = createMemo(() => {
    const row = conversations().find((summary) => summary.id === shown())
    return row?.label === 'coordinator' && row.ownerTaskId === undefined ? row.id : undefined
  })
  return (
    <Show keyed when={coordinator()}>
      {(id) => chip(id, 'branch', 'this branch')}
    </Show>
  )
}
