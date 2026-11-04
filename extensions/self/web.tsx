import { RotateCwIcon, TriangleAlertIcon, ZapIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Shimmer } from '@/components/ai/shimmer'
import { Tool, ToolContent, ToolHeader, ToolOutput, ToolSection } from '@/components/ai/tool'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  cn,
  defineWebExtension,
  formatTime,
  switched,
  useEvents,
  useRestart,
  useSystem,
  useToolDuration,
  useUltimate,
} from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { ConversationRef } from '../conversations/ui.tsx'
import { SubmissionLanded } from '../workspaces/ui.tsx'

const short = (id: string | undefined) => id?.slice(0, 7)

interface RestartDetails {
  fromGeneration?: number
  toGeneration?: number
  fromBuild?: string
  toBuild?: string
  refused?: boolean
  rolledBack?: boolean
  error?: string
}

/**
 * The `restart` tool: the swap's generations and builds from its `details`, or the boot error that kept the old core
 * serving. A record without details reads as a plain core swap.
 */
function RestartCall({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const result = (call.details ?? {}) as RestartDetails
  const failed = call.status === 'error'
  const generations =
    result.fromGeneration !== undefined
      ? `gen ${result.fromGeneration} → ${result.toGeneration}`
      : `gen → ${result.toGeneration}`
  const builds =
    result.fromBuild && result.toBuild && result.fromBuild === result.toBuild ? (
      ' · same build'
    ) : result.fromBuild && result.toBuild ? (
      <>
        {' '}
        · build {short(result.fromBuild)} →{' '}
        <span className="text-foreground/85">{short(result.toBuild)}</span>
      </>
    ) : null
  const title: ReactNode =
    call.status === 'done' && result.toGeneration !== undefined ? (
      <>
        <span className="text-success">swapped</span> · {generations}
        {builds}
      </>
    ) : failed && result.refused ? (
      <span className="text-error">restart refused · shared host unchanged</span>
    ) : failed && result.rolledBack ? (
      <span className="text-error">
        activation failed · rolled back to gen {result.toGeneration ?? result.fromGeneration}
      </span>
    ) : failed ? (
      <span className="text-error">boot failed · the old core kept serving</span>
    ) : call.status === 'running' || call.status === 'pending' ? (
      'type-checking and booting a new core…'
    ) : call.status === 'interrupted' ? (
      'interrupted'
    ) : (
      'core swap'
    )
  const error = result.error ?? (failed ? call.output : undefined)
  return (
    <Tool defaultOpen={failed}>
      <ToolHeader meta={duration} name="restart" state={call.status} title={title} />
      <ToolContent>
        {call.status === 'running' && (
          <ToolSection>
            <Shimmer className="text-[12px]">
              blue/green swap: type-check, boot, hand over storage, resume this run…
            </Shimmer>
          </ToolSection>
        )}
        {error ? (
          <ToolOutput isError output={error} />
        ) : (
          call.output && <ToolSection className="text-muted-foreground">{call.output}</ToolSection>
        )}
      </ToolContent>
    </Tool>
  )
}

/** A status-line item next to the generation while `server/` or `shared/` changed since this core booted. */
function CoreStale() {
  const system = useSystem()
  const restart = useRestart()
  if (restart.error)
    return (
      <Popover onOpenChange={(open) => !open && restart.clear()}>
        <PopoverTrigger asChild>
          <button
            className="-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-error transition-colors hover:bg-accent"
            type="button"
          >
            <TriangleAlertIcon className="size-3" />
            restart failed
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[32rem] p-0 font-mono" side="top">
          <div className="border-b border-border/70 px-3 py-2 text-[11.5px] text-muted-foreground">
            The shared Ultimate host restart did not take.
          </div>
          <pre className="max-h-80 overflow-auto px-3 py-2 text-[11.5px] leading-[1.55] whitespace-pre-wrap text-error">
            {restart.error}
          </pre>
          <div className="flex justify-end gap-2 border-t border-border/70 px-3 py-2">
            <Button className="h-7 text-[12px]" onClick={restart.clear} size="sm" variant="ghost">
              Dismiss
            </Button>
            <Button
              className="h-7 text-[12px]"
              onClick={() => {
                restart.clear()
                restart.run()
              }}
              size="sm"
              variant="outline"
            >
              Try again
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    )
  if (!system?.code.coreStale && !restart.busy) return null
  // A phone's status line has room for the action only.
  const stale = (
    <span>
      <span className="max-md:hidden">core changed · </span>restart
    </span>
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={cn(
            '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors',
            restart.busy ? 'text-brand' : 'text-warning hover:bg-accent',
          )}
          disabled={restart.busy}
          onClick={restart.run}
          type="button"
        >
          <RotateCwIcon className={cn('size-3', restart.busy && 'animate-spin')} />
          {restart.pending !== undefined
            ? `swapping to gen ${restart.pending}…`
            : restart.busy
              ? 'checking…'
              : stale}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-80 font-mono text-[11px]" side="top">
        server/ or shared/ changed since generation {system?.process.generation} booted. Restart
        type-checks and boots a new core next to this one; if it fails, this one keeps serving.
      </TooltipContent>
    </Tooltip>
  )
}

/** `build a1b2c3d` in the status line; it lights up when the build changes. */
function Build() {
  const system = useSystem()
  const id = system?.build.id
  const [fresh, setFresh] = useState(false)
  const last = useRef(id)
  useEffect(() => {
    if (!id || last.current === id) return undefined
    const first = last.current === undefined
    last.current = id
    if (first) return undefined
    setFresh(true)
    const timer = setTimeout(() => setFresh(false), 4000)
    return () => clearTimeout(timer)
  }, [id])
  if (!system) return null
  const { build } = system
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'transition-colors duration-700',
            fresh ? 'text-brand' : 'text-muted-foreground/80',
          )}
        >
          build {short(build.id)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[28rem] font-mono text-[11px]" side="top">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
          <span className="opacity-60">build</span>
          <span>
            {build.id} · gen {build.generation}
          </span>
          <span className="opacity-60">core</span>
          <span>{build.core.slice(0, 12)}</span>
          {Object.entries(build.extensions).map(([name, hash]) => (
            <span className="contents" key={name}>
              <span className="opacity-60">{name}</span>
              <span>{hash.slice(0, 12)}</span>
            </span>
          ))}
        </div>
        {build.history.length > 1 && (
          <div className="mt-2 border-t border-current/20 pt-1.5">
            {build.history
              .toReversed()
              .slice(0, 8)
              .map((entry) => (
                <div className="flex gap-2" key={`${entry.id}-${entry.at}`}>
                  <span className="opacity-60">{formatTime(entry.at, true)}</span>
                  <span>{short(entry.id)}</span>
                  <span className="truncate opacity-80">
                    {entry.changed.length ? entry.changed.join(', ') : `gen ${entry.generation}`}
                  </span>
                </div>
              ))}
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

/** How long the update toast stays. */
const lifetime = 4000

/** `extensions/lineage/web.tsx` as `lineage/web.tsx`: enough to recognise the file. */
const shortFile = (path: string) => path.split('/').slice(-2).join('/')

/** How far apart a landing and the switch it brought may be: the lander fast-forwards, then records it. */
const landingWindow = 60_000

/**
 * A quiet toast above the bottom right of the status line after the page switched to a new web bundle: the branches
 * whose landing brought it, else the sources that changed.
 */
function Updated() {
  const [shown, setShown] = useState(switched !== undefined)
  const { switchConversation } = useUltimate()
  const events = useEvents({ events: [SubmissionLanded], limit: 5 })
  useEffect(() => {
    if (!shown) return undefined
    const timer = setTimeout(() => setShown(false), lifetime)
    return () => clearTimeout(timer)
  }, [shown])
  if (!shown || !switched) return null
  const { at } = switched
  const landings = (events ?? [])
    .filter((event) => Math.abs(at - Date.parse(event.at)) < landingWindow)
    .map((event) => event.data)
  const files = switched.changed
  if (landings.length > 0)
    return (
      <div
        className="fixed right-3 bottom-9 z-40 flex max-w-[28rem] animate-in items-center gap-1.5 rounded-md border border-border/80 bg-popover px-2.5 py-1.5 font-mono text-[11.5px] text-muted-foreground shadow-lg fade-in-0 slide-in-from-bottom-1"
        role="status"
      >
        <ZapIcon className="size-3.5 shrink-0 text-brand" />
        <span className="shrink-0 text-foreground/90">Landed</span>
        <button
          className="flex min-w-0 cursor-pointer overflow-hidden hover:underline"
          onClick={() => switchConversation(landings[0].conversationId)}
          title={`Open #${landings[0].conversationId}`}
          type="button"
        >
          <ConversationRef id={landings[0].conversationId} title={landings[0].title || undefined} />
        </button>
        {landings.length > 1 && <span className="shrink-0">+{landings.length - 1}</span>}
      </div>
    )
  if (files.length === 0) return null
  const named = files.map(shortFile)
  return (
    <div
      className="pointer-events-none fixed right-3 bottom-9 z-40 flex max-w-96 animate-in items-center gap-1.5 rounded-md border border-border/80 bg-popover px-2.5 py-1.5 font-mono text-[11.5px] text-muted-foreground shadow-lg fade-in-0 slide-in-from-bottom-1"
      role="status"
    >
      <ZapIcon className="size-3.5 shrink-0 text-brand" />
      <span className="shrink-0 text-foreground/90">Updated</span>
      <span className="truncate">{named.slice(0, 2).join(', ')}</span>
      {named.length > 2 && <span className="shrink-0">+{named.length - 2}</span>}
    </div>
  )
}

export default defineWebExtension({
  tools: { restart: RestartCall },
  slots: {
    // Discovery order puts `self` before `status-line`: the item sits just left of `live · gen N`.
    'statusline.right': [
      { component: CoreStale, phone: true },
      { component: Build, order: 1 },
    ],
    overlay: Updated,
  },
})
