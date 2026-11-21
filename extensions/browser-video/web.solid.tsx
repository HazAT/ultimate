/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { ChevronUp, Play } from '@lucide/solid'
import { For, Show, createMemo, createSignal, createUniqueId } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  cn,
  defineWebExtension,
  extensionFileUrl,
  provide,
  useAction,
  useSurface,
  type SolidToolProps,
} from '@/sdk/solid'
import { browserVideoOf, type BrowserClip } from '../../lib/browser-video.ts'
import { meansNone } from '../../lib/errors.ts'
import type { Message } from '../messages/refs.ts'
import { MessageExtras } from '../messages/ui.solid.tsx'
import { LandingExtras } from '../workspaces/ui.solid.tsx'
import { LandingClipsAction } from './refs.ts'

function Player(props: { id: string; label: string }) {
  const [unavailable, setUnavailable] = createSignal(false)
  return (
    <Show
      when={!unavailable()}
      fallback={<output class="block text-xs text-muted-foreground">Video unavailable.</output>}
    >
      <video
        aria-label={props.label}
        class="block aspect-video max-h-[26rem] w-full max-w-[30rem] rounded-md bg-muted object-contain"
        controls
        muted
        onError={() => setUnavailable(true)}
        onLoadedMetadata={(event) => void event.currentTarget.play().catch(meansNone)}
        playsinline
        preload="metadata"
        src={extensionFileUrl('browser-video', props.id, 'video')}
      />
    </Show>
  )
}

function Video(props: {
  clip: BrowserClip
  context: string
  placement: 'tool' | 'message' | 'inbox' | 'landing'
  class?: string
}) {
  const [active, setActive] = createSignal<string>()
  const player = createUniqueId()
  const opened = () => active() === props.clip.id
  const action = () => (opened() ? 'Hide video' : 'Play video')
  return (
    <div
      class={cn('min-w-0', props.class)}
      data-browser-clip={props.clip.id}
      data-browser-video={props.placement}
    >
      <Button
        aria-controls={opened() ? player : undefined}
        aria-description={props.clip.title || undefined}
        aria-expanded={opened() ? 'true' : 'false'}
        aria-label={`${action()} for ${props.context}`}
        class="h-7 max-w-full gap-1.5 rounded px-1.5 font-mono text-[11px] font-normal text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        onClick={() => setActive(opened() ? undefined : props.clip.id)}
        size={null}
        variant={null}
      >
        <Show
          when={opened()}
          fallback={<Play aria-hidden="true" class="size-3 shrink-0 fill-current text-brand" />}
        >
          <ChevronUp aria-hidden="true" class="size-3 shrink-0 text-brand" />
        </Show>
        <span class="shrink-0 text-foreground/90">{action()}</span>
        <Show when={props.clip.title}>
          <span class="truncate" title={props.clip.title}>
            {props.clip.title}
          </span>
        </Show>
      </Button>
      <Show when={opened() && props.clip.id} keyed>
        {(id) => (
          <div class="mt-1" id={player}>
            <Player id={id} label={`Browser recording from ${props.context}`} />
          </div>
        )}
      </Show>
    </div>
  )
}

function VideoTool(props: SolidToolProps) {
  const clip = createMemo(() => props.call.status === 'done' && browserVideoOf(props.call.details))
  return (
    <>
      {props.core}
      <Show when={clip()}>
        {(selected) => (
          <Video
            class="mt-1 px-2"
            clip={selected()}
            context={`tool call ${props.call.id}`}
            placement="tool"
          />
        )}
      </Show>
    </>
  )
}

function MessageVideo(props: { message: Message }) {
  const surface = useSurface()
  const inbox = () => surface() === 'inbox'
  return (
    <Show when={props.message.video}>
      {(clip) => (
        <Video
          class={cn('px-2.5 py-1.5', !inbox() && 'border-t border-border/60')}
          clip={clip()}
          context={`${inbox() ? 'Inbox' : 'transcript'} message #${props.message.id}`}
          placement={inbox() ? 'inbox' : 'message'}
        />
      )}
    </Show>
  )
}

function LandingVideos(props: { conversation: ConversationId; card: number }) {
  const { data, error } = useAction(
    LandingClipsAction,
    {
      get conversation() {
        return props.conversation
      },
    },
    { onError: meansNone },
  )
  return (
    <>
      <For each={data()} keyed={(clip) => clip.id}>
        {(clip, index) => (
          <Video
            clip={clip()}
            context={`landing #${props.card}, clip ${index() + 1}`}
            placement="landing"
          />
        )}
      </For>
      <Show when={error() && !data()}>
        <output class="block text-xs text-muted-foreground">Could not load videos.</output>
      </Show>
    </>
  )
}

export default defineWebExtension({
  tools: { browser_video: VideoTool },
  provides: [provide(MessageExtras, MessageVideo), provide(LandingExtras, LandingVideos)],
})
