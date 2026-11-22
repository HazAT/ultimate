import { LoaderCircle, RotateCw, TriangleAlert, Zap } from '@lucide/solid'
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onSettled,
} from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Popover, PopoverContent } from '@/components/ui/popover.solid.tsx'
import { StatusPopoverTrigger } from '@/components/ui/status-trigger.solid.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
import { bundle, cn, formatTime, switched, useNow, useRestart, useSystem } from '@/sdk/solid'
import { deadline } from '../../lib/timers.ts'
import type { Cancel } from '../../lib/timers.ts'

const short = (id: string) => id.slice(0, 7)
const switching = (id?: string) => Boolean(id && bundle && id !== bundle)
const warningHeader = 'border-b border-border/70 px-3 py-2 text-[11.5px] text-muted-foreground'
const warningDetail =
  'max-h-80 overflow-auto px-3 py-2 text-[11.5px] leading-[1.55] whitespace-pre-wrap text-error'

export function CoreStale() {
  const system = useSystem()
  const restart = useRestart()
  return (
    <Switch>
      <Match when={restart.error()}>
        <Popover onOpenChange={(open) => void (!open && restart.clear())}>
          <StatusPopoverTrigger class="text-error hover:text-error data-open:text-error">
            <TriangleAlert class="size-3" />
            restart failed
          </StatusPopoverTrigger>
          <PopoverContent align="end" class="w-[32rem] p-0 font-mono" side="top">
            <div class={warningHeader}>The shared Ultimate host restart did not take.</div>
            <pre class={warningDetail}>{restart.error()}</pre>
            <div class="flex justify-end gap-2 border-t border-border/70 px-3 py-2">
              <Button class="h-7 text-[12px]" onClick={restart.clear} size="sm" variant="ghost">
                Dismiss
              </Button>
              <Button
                class="h-7 text-[12px]"
                data-agent-confirm="Restarts the shared Ultimate host."
                onClick={restart.run}
                size="sm"
                variant="outline"
              >
                Try again
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </Match>
      <Match when={system()?.code.coreStale || restart.busy()}>
        <Tooltip>
          <TooltipTrigger
            render={(trigger) => (
              <Button
                {...trigger}
                class={cn(
                  '-mx-1 flex gap-1.5 rounded-sm px-1 font-[family-name:inherit] text-[length:inherit] leading-[inherit] font-normal transition-colors data-disabled:opacity-100',
                  restart.busy() ? 'text-brand' : 'text-warning hover:bg-accent',
                )}
                data-agent-confirm="Restarts the shared Ultimate host."
                disabled={restart.busy()}
                focusableWhenDisabled
                onClick={restart.run}
                size={null}
                variant={null}
              />
            )}
          >
            <RotateCw class={cn('size-3', restart.busy() && 'animate-spin')} />
            {restart.pending() !== undefined ? (
              `swapping to gen ${restart.pending()}…`
            ) : restart.busy() ? (
              'checking…'
            ) : (
              <span>
                <span class="max-md:hidden">core changed · </span>restart
              </span>
            )}
          </TooltipTrigger>
          <TooltipContent class="max-w-80 font-mono text-[11px]" side="top">
            server/ or shared/ changed since generation {system()?.process.generation} booted.
            Restart type-checks and boots a new core next to this one; if it fails, this one keeps
            serving.
          </TooltipContent>
        </Tooltip>
      </Match>
    </Switch>
  )
}

export function Rebuild() {
  const system = useSystem()
  const web = () => system()?.web
  const building = createMemo(() => web()?.building === true)
  const error = () => web()?.error
  const left = () => web()?.left
  const since = createMemo(() => (building() ? Date.now() : 0))
  const now = useNow(1000, building)
  return (
    <Switch>
      <Match when={switching(web()?.id)}>
        <span class="flex items-center gap-1.5 text-brand">
          <Zap class="size-3" />
          ready · switching
        </span>
      </Match>
      <Match when={building()}>
        <span class="flex items-center gap-1.5 text-muted-foreground">
          <LoaderCircle class="size-3 animate-spin" />
          building… {Math.max(0, Math.floor((now() - since()) / 1000))}s
        </span>
      </Match>
      <Match when={error() || left()}>
        <Popover>
          <StatusPopoverTrigger
            class={
              error()
                ? 'text-error hover:text-error data-open:text-error'
                : 'text-warning hover:text-warning data-open:text-warning'
            }
          >
            <TriangleAlert class="size-3" />
            {error()
              ? 'build failed'
              : `${left()?.length} ${left()?.length === 1 ? 'facet' : 'facets'} left out`}
          </StatusPopoverTrigger>
          <PopoverContent
            align="end"
            class="w-[32rem] max-w-[calc(100vw-2rem)] p-0 font-mono"
            side="top"
          >
            <div class={warningHeader}>
              {error()
                ? 'The web UI did not build; this page keeps the previous bundle.'
                : 'Left out of the web bundle; their cards show the error until a save fixes them.'}
            </div>
            <pre class={warningDetail}>
              {error() ??
                left()
                  ?.map((entry) => `${entry.file}\n${entry.error}`)
                  .join('\n\n')}
            </pre>
          </PopoverContent>
        </Popover>
      </Match>
    </Switch>
  )
}

export function Build() {
  const system = useSystem()
  const [fresh, setFresh] = createSignal(switched !== undefined)
  let last: string | undefined
  let cancel: Cancel | undefined
  const highlight = () => {
    cancel?.()
    setFresh(true)
    cancel = deadline(4000, () => setFresh(false))
  }
  onSettled(() => {
    if (switched) highlight()
    return () => cancel?.()
  })
  createEffect(
    () => system()?.build.id,
    (id) => {
      if (!id || id === last) return
      if (last !== undefined) highlight()
      last = id
    },
  )
  const current = () => {
    const value = system()
    if (!value) return undefined
    const { web } = value
    return web.building || web.error || web.left || switching(web.id) ? undefined : value.build
  }
  return (
    <Show when={current()}>
      {(build) => (
        <Tooltip>
          <TooltipTrigger
            aria-label={`build ${short(build().id)}`}
            class={cn(
              'transition-colors duration-700',
              fresh() ? 'text-brand' : 'text-muted-foreground/80',
            )}
            render={(trigger) => <span {...trigger} />}
          >
            build {short(build().id)}
          </TooltipTrigger>
          <TooltipContent class="max-w-[28rem] font-mono text-[11px]" side="top">
            <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
              <span class="opacity-60">build</span>
              <span>
                {build().id} · gen {build().generation}
              </span>
              <span class="opacity-60">core</span>
              <span>{build().core.slice(0, 12)}</span>
              <For each={Object.entries(build().extensions)}>
                {([name, hash]) => (
                  <>
                    <span class="opacity-60">{name}</span>
                    <span>{hash.slice(0, 12)}</span>
                  </>
                )}
              </For>
            </div>
            <Show when={build().history.length > 1}>
              <div class="mt-2 border-t border-current/20 pt-1.5">
                <For each={build().history.toReversed().slice(0, 8)}>
                  {(entry) => (
                    <div class="flex gap-2">
                      <span class="opacity-60">{formatTime(entry.at, true)}</span>
                      <span>{short(entry.id)}</span>
                      <span class="truncate opacity-80">
                        {entry.changed.length
                          ? entry.changed.join(', ')
                          : `gen ${entry.generation}`}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </TooltipContent>
        </Tooltip>
      )}
    </Show>
  )
}
