import type { ConversationId } from '@earendil-works/pi-durable'
import { createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import { Shimmer } from '@/components/ai/shimmer.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import { cn, ROOT, useConversations, useDocOf } from '@/sdk/solid'
import { dock, playerState, setVoiceOpen, voiceOpen } from './dock.solid.tsx'
import { VoiceForkDoc, VoiceSessionDoc } from './refs.ts'

type Live = 'listening' | 'speaking' | 'thinking' | 'handed off' | 'open'

const bars = [0.55, 1, 0.7]

const sway = `@keyframes voice-row-sway {
  0%, 100% { transform: scaleY(0.35); }
  50% { transform: scaleY(1); }
}`

function Level(props: { live: Live }) {
  const [level, setLevel] = createSignal(0)
  onSettled(() =>
    dock.mic.onLevel(() => {
      const levels = dock.mic.levels()
      setLevel(levels[levels.length - 1] ?? 0)
    }),
  )
  return (
    <span aria-hidden="true" class="flex h-3 w-3 shrink-0 items-center justify-center gap-[2px]">
      <style>{sway}</style>
      <For each={bars}>
        {(weight, index) => (
          <span
            class={cn(
              'h-full w-[2px] origin-center rounded-full transition-transform duration-75',
              props.live === 'listening'
                ? 'bg-error'
                : props.live === 'open' || props.live === 'handed off'
                  ? 'bg-muted-foreground/60'
                  : 'bg-brand',
              props.live === 'speaking' &&
                'motion-safe:animate-[voice-row-sway_0.9s_ease-in-out_infinite]',
              props.live === 'thinking' && 'animate-pulse-dot',
            )}
            data-voice-bar={index()}
            style={{
              'animation-delay': `${index() * 0.15}s`,
              transform:
                props.live === 'listening'
                  ? `scaleY(${Math.max(0.2, Math.min(1, level() * 1.6 * weight))})`
                  : props.live === 'speaking'
                    ? undefined
                    : `scaleY(${0.3 * weight + 0.05})`,
            }}
          />
        )}
      </For>
    </span>
  )
}

export function VoiceRow(props: { conversation: ConversationId | undefined }) {
  const session = useDocOf(() => ROOT, VoiceSessionDoc)
  const id = () => session()?.id
  const fork = useDocOf(id, VoiceForkDoc)
  const conversations = useConversations()
  const busy = () => conversations().some((row) => row.id === id() && row.busy)
  const live = createMemo((): Live => {
    if (dock.phase() === 'recording') return 'listening'
    if (playerState().playing) return 'speaking'
    if (dock.phase() === 'sending' || busy()) return 'thinking'
    return fork()?.handedOff ? 'handed off' : 'open'
  })
  return (
    <Show when={props.conversation !== undefined && id() !== undefined}>
      <Button
        aria-current={voiceOpen() ? 'true' : undefined}
        aria-label="Voice session"
        class="mx-2 flex w-[calc(100%-1rem)] items-center justify-start gap-1.5 rounded-md py-1.5 pr-2 pl-9 text-left font-normal outline-none hover:bg-sidebar-accent/50 focus-visible:ring-1 focus-visible:ring-ring"
        data-voice-row={id()}
        data-voice-live={live()}
        onClick={() => setVoiceOpen(!voiceOpen())}
        size={null}
        title={`Voice session · ${live()}`}
        variant={null}
      >
        <Level live={live()} />
        <span class="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground/80">
          Voice
        </span>
        <span
          class={cn(
            'shrink-0 font-mono text-[10px]',
            live() === 'listening'
              ? 'text-error'
              : live() === 'speaking' || live() === 'thinking'
                ? 'text-brand'
                : 'text-muted-foreground',
          )}
        >
          <Show when={live() === 'thinking'} fallback={live()}>
            <Shimmer>thinking</Shimmer>
          </Show>
        </span>
      </Button>
    </Show>
  )
}

export function voiceForks() {
  const session = useDocOf(() => ROOT, VoiceSessionDoc)
  return createMemo(() => {
    const current = session()
    return new Set<number>([
      ...(current?.forks ?? []),
      ...(current?.id === undefined ? [] : [current.id]),
    ])
  })
}
