import { Flame } from '@lucide/solid'
import { Show } from 'solid-js'
import { Popover, PopoverContent } from '@/components/ui/popover.solid.tsx'
import { StatusPopoverTrigger } from '@/components/ui/status-trigger.solid.tsx'
import { Switch } from '@/components/ui/switch.solid.tsx'
import { ROOT, api, cn, formatAgo, keepLast, useAction, useDocOf, useNow } from '@/sdk/solid'
import { failing, TTL } from './due.shared.ts'
import { SetAction, StateAction, WarmDoc } from './refs.ts'
import type { WarmState } from './refs.ts'

const tokens = (count = 0) => (count >= 1000 ? `${Math.round(count / 1000)}k` : String(count))

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function cacheLine(state: WarmState, now: number) {
  if (state.lastRequest === undefined) return 'No Claude request yet'
  const until = state.lastRequest + TTL
  return until > now ? `Warm until ${clock(until)}` : `Cold since ${clock(until)}`
}

function nextLine(state: WarmState, now: number) {
  if (!state.on) return 'Off'
  if (state.nextAt !== undefined) return `Next ping ${clock(Math.max(now, state.nextAt))}`
  if (state.lastRequest !== undefined && failed(state)) return 'Waiting for @ultimate’s next answer'
  if (state.lastRequest !== undefined && state.lastRequest + TTL <= now) return 'Cache is cold'
  return 'Stopped: no input from you for 8 h'
}

const failed = (state: WarmState) =>
  state.last?.error !== undefined && failing(state.last.at, state.lastRequest)

const toggle = (on: boolean) =>
  api.action(SetAction, { on }).catch((error: unknown) => console.warn('Keep warm', error))

export function Chip() {
  const doc = useDocOf(() => ROOT, WarmDoc)
  const { data } = useAction(StateAction, null, {
    conversation: ROOT,
    onError: keepLast,
    on: doc,
    every: 60_000,
  })
  const now = useNow(60_000)
  return (
    <Show when={data()}>
      {(state) => {
        const warm = () => state().lastRequest !== undefined && state().lastRequest! + TTL > now()
        return (
          <Popover>
            <StatusPopoverTrigger
              aria-label="Keep @ultimate's cache warm"
              class={cn(!state().on && 'text-muted-foreground/60')}
              data-keep-warm={state().on ? (warm() ? 'warm' : 'cold') : 'off'}
            >
              <Flame
                class={cn(
                  'size-3',
                  state().on && warm() && 'text-amber-500',
                  failed(state()) && 'text-red-500',
                )}
              />
              warm
            </StatusPopoverTrigger>
            <PopoverContent align="end" class="w-64 p-1 font-mono" side="top">
              <label class="flex h-8 items-center justify-between px-2 text-[12px]">
                Keep @ultimate warm
                <Switch bind={[() => state().on, (on) => void toggle(on)]} />
              </label>
              <div class="space-y-1 border-t border-border/70 px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground">
                <div class="text-foreground/80">{cacheLine(state(), now())}</div>
                <div>{nextLine(state(), now())}</div>
                <Show when={state().last}>
                  {(last) => (
                    <div class={cn(failed(state()) && 'text-red-500')}>
                      Last ping {formatAgo(last().at)}
                      {last().error !== undefined
                        ? `: ${last().error}`
                        : ` · read ${tokens(last().read)}, wrote ${tokens(last().write)}`}
                    </div>
                  )}
                </Show>
                <div class="pt-1 text-muted-foreground/70">
                  One small request 55 min after the last, until you have been away 8 h.
                </div>
              </div>
            </PopoverContent>
          </Popover>
        )
      }}
    </Show>
  )
}
