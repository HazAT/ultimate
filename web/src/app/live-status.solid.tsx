import type { ConversationId, LiveState } from '@earendil-works/pi-durable'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { Pause, RotateCw } from '@lucide/solid'
import { createMemo, For, Show } from 'solid-js'

import { Shimmer } from '@/components/ai/shimmer.solid.tsx'
import { formatDuration, ParkedRuns, RunStart, useNow } from '../sdk/hooks.ts'
import { useProvided } from '../sdk/contribution.solid.tsx'

function partialHasVisibleContent(message: AssistantMessage | undefined) {
  return !!message?.content.some((block) =>
    block.type === 'toolCall'
      ? true
      : block.type === 'text'
        ? !!block.text
        : !!block.thinking || !!block.redacted,
  )
}

export function LiveStatus(props: {
  id: ConversationId | undefined
  live: LiveState
  busy: boolean
  partial: AssistantMessage | undefined
}) {
  const parked = useProvided(ParkedRuns, () => null)
  const since = useProvided(RunStart, () => props.live.run?.taskId)
  return (
    <LiveLines
      busy={props.busy}
      live={props.live}
      parked={props.id !== undefined && parked()?.has(props.id) === true}
      partial={props.partial}
      since={since()}
    />
  )
}

export function LiveLines(props: {
  live: LiveState
  busy: boolean
  partial: AssistantMessage | undefined
  parked: boolean
  since?: number
}) {
  const paused = () => props.busy && props.parked
  const retry = () => (paused() ? undefined : props.live.generation?.retry)
  const running = () => (props.live.tools ?? []).some((slot) => slot.status !== 'done')
  const idle = () => props.busy && !partialHasVisibleContent(props.partial) && !running()
  const ticking = createMemo(() => !paused() && (!!retry() || idle()))
  const now = useNow(100, ticking)
  const compactions = () => props.live.compactions ?? []
  const working = () =>
    idle() && !retry() && !props.live.generation?.deferred && compactions().length === 0
  return (
    <Show
      when={!paused()}
      fallback={
        <div class="flex flex-col gap-1 font-mono text-[12px] text-muted-foreground">
          <span class="flex items-center gap-2 text-warning" data-paused-run>
            <Pause aria-hidden="true" class="size-3" />
            paused · runs on Play
          </span>
        </div>
      }
    >
      <Show
        when={retry() || props.live.generation?.deferred || compactions().length > 0 || working()}
      >
        <div class="flex flex-col gap-1 font-mono text-[12px] text-muted-foreground">
          <Show when={retry()}>
            {(pending) => (
              <span class="flex items-center gap-1.5 text-warning">
                <RotateCw aria-hidden="true" class="size-3" />
                retrying in {formatDuration(Math.max(0, pending().at - now()))} · attempt{' '}
                {props.live.generation?.attempt ?? 1} ·{' '}
                <span class="truncate">{pending().error}</span>
              </span>
            )}
          </Show>
          <Show when={props.live.generation?.deferred}>
            <Shimmer>waiting for the provider…</Shimmer>
          </Show>
          <For each={compactions()} keyed={(compaction) => compaction.taskId}>
            {(compaction) => (
              <Shimmer>
                {`compacting context · ${compaction().trigger}${compaction().attempt > 1 ? ` · attempt ${compaction().attempt}` : ''}…`}
              </Shimmer>
            )}
          </For>
          <Show when={working()}>
            <span class="flex items-center gap-2">
              <span class="size-1.5 animate-pulse-dot rounded-full bg-brand" />
              <Shimmer>
                {props.partial?.content.some((block) => block.type === 'thinking')
                  ? 'thinking…'
                  : 'working…'}
              </Shimmer>
              <Show when={props.since !== undefined && now() - props.since >= 2000}>
                <span class="text-muted-foreground/60 tabular-nums">
                  {formatDuration(now() - props.since!)}
                </span>
              </Show>
            </span>
          </Show>
        </div>
      </Show>
    </Show>
  )
}
