import { FlameIcon } from 'lucide-react'
import { useEffect } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { api, cn, defineWebExtension, formatAgo, useAction, useDocOf, useNow } from '@/sdk'
import { failing, TTL } from './due.ts'
import { SetAction, StateAction, WarmDoc } from './refs.ts'
import type { WarmState } from './refs.ts'

const tokens = (count = 0) => (count >= 1000 ? `${Math.round(count / 1000)}k` : String(count))

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** Where the cache stands: warm until the hour after @ultimate's last request ends, else cold. */
function cacheLine(state: WarmState, now: number) {
  if (state.lastRequest === undefined) return 'No Claude request yet'
  const until = state.lastRequest + TTL
  return until > now ? `Warm until ${clock(until)}` : `Cold since ${clock(until)}`
}

/** Why no ping is coming, or when the next one is. */
function nextLine(state: WarmState, now: number) {
  if (!state.on) return 'Off'
  if (state.nextAt !== undefined) return `Next ping ${clock(Math.max(now, state.nextAt))}`
  if (state.lastRequest !== undefined && failed(state)) return 'Waiting for @ultimate’s next answer'
  if (state.lastRequest !== undefined && state.lastRequest + TTL <= now) return 'Cache is cold'
  return 'Stopped: no input from you for 8 h'
}

/** The last ping failed and nothing renewed the cache since: a later cached answer from @ultimate clears it. */
const failed = (state: WarmState) =>
  state.last?.error !== undefined && failing(state.last.at, state.lastRequest)

/**
 * The status-line chip: whether @ultimate's prompt cache is kept warm. Quiet while it is, dimmed while off; the
 * popover has the switch, where the cache stands and the last ping.
 */
function Chip() {
  const doc = useDocOf(1, WarmDoc)
  const { data: state, refetch } = useAction(
    StateAction,
    null,
    // A failed poll keeps the last state; the next one asks again.
    { onError: () => {} },
  )
  const now = useNow(60_000)
  useEffect(() => {
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    void refetch()
  }, [doc, now, refetch])
  if (!state) return null
  const warm = state.lastRequest !== undefined && state.lastRequest + TTL > now
  const red = failed(state)
  const toggle = (on: boolean) =>
    api
      .action(SetAction, { on })
      // The state comes back from the document change; a failure leaves the switch as it was.
      .catch((error: unknown) => console.warn('Keep warm', error))
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label="Keep @ultimate's cache warm"
          className={cn(
            '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground',
            !state.on && 'text-muted-foreground',
          )}
          data-keep-warm={state.on ? (warm ? 'warm' : 'cold') : 'off'}
          type="button"
        >
          <FlameIcon
            className={cn('size-3', state.on && warm && 'text-amber-500', red && 'text-red-500')}
          />
          warm
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1 font-mono" side="top">
        <label className="flex h-8 cursor-pointer items-center justify-between px-2 text-[0.75rem]">
          Keep @ultimate warm
          <Switch checked={state.on} onCheckedChange={(on) => void toggle(on)} />
        </label>
        <div className="space-y-1 border-t border-border/70 px-2 pt-1.5 pb-1 text-[0.6875rem] text-muted-foreground">
          <div className="text-foreground/80">{cacheLine(state, now)}</div>
          <div>{nextLine(state, now)}</div>
          {state.last && (
            <div className={cn(red && 'text-red-500')}>
              Last ping {formatAgo(state.last.at)}
              {state.last.error !== undefined
                ? `: ${state.last.error}`
                : ` · read ${tokens(state.last.read)}, wrote ${tokens(state.last.write)}`}
            </div>
          )}
          <div className="pt-1 text-muted-foreground">
            One small request 55 min after the last, until you have been away 8 h.
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: Chip, order: -1 }] },
})
