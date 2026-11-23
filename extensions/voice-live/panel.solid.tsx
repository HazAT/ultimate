import {
  AudioLines,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Mic,
  Minimize2,
  Pause,
  Play,
  Settings2,
  SkipBack,
  SkipForward,
  SquareArrowOutUpRight,
  X,
} from '@lucide/solid'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { JSX } from '@solidjs/web'
import { createEffect, createMemo, createSignal, onSettled, Show } from 'solid-js'
import { Shimmer } from '@/components/ai/shimmer.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import { Kbd } from '@/components/ui/kbd.solid.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import { Slider } from '@/components/ui/slider.solid.tsx'
import { Switch as Toggle } from '@/components/ui/switch.solid.tsx'
import {
  api,
  chordOf,
  cn,
  Composer,
  ComposerRedirect,
  formatKeys,
  ROOT,
  ScopedConversation,
  switchConversation,
  useAction,
  useConversationId,
  useConversationSummary,
  useDocOf,
  useExtensionUiState,
  useExternal,
  useSurface,
  useViewport,
} from '@/sdk/solid'
import type { ComposerTarget } from '@/sdk/solid'
import { every } from '../../lib/timers.ts'
import { ModelSelect } from '../models/ui.solid.tsx'
import {
  dock,
  endSession,
  KEYS,
  press,
  release,
  sendTyped,
  setScreen,
  setVoiceOpen,
  voiceOpen,
} from './dock.solid.tsx'
import { ModelAction, StatusAction, VoiceForkDoc, VoiceSessionDoc } from './refs.ts'
import { estimate } from './speech.ts'
import { Session, Voicing, Waveform } from './turns.solid.tsx'

const toolbarButton =
  'flex h-7 max-w-56 min-w-0 shrink items-center gap-1.5 rounded-md px-2 font-mono text-[11.5px] font-normal text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-open:bg-accent data-open:text-foreground'
const iconButton =
  'flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-open:bg-accent data-open:text-foreground pointer-coarse:size-9'
const rowButton =
  'h-auto rounded p-0.5 font-normal text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-3'
const keys = () => formatKeys(KEYS)[0].join('+')
const holdKeys = () => formatKeys(dock.holdKeys())[0].join('+')
const parseHold = () => dock.holdKeys().trim().toLowerCase()
const keyChord = (event: KeyboardEvent) =>
  event.code === 'Space' ? chordOf(event).replace(/ $/, 'space') : chordOf(event)

const recording = () => dock.phase() === 'recording'
const working = () => dock.phase() === 'sending' || dock.phase() === 'thinking'

export function VoiceModel(props: { class?: string }) {
  const status = useAction(StatusAction, null, { conversation: ROOT })
  return (
    <ModelSelect
      class={props.class}
      compact
      name="Voice model"
      onChange={(model) => {
        if (!model) return undefined
        return api.action(ModelAction, { model }).then(() => status.refetch())
      }}
      value={status.data()?.model}
    />
  )
}

function Status(props: { class?: string }) {
  const text = () => dock.error() ?? dock.status()
  return (
    <output
      class={cn(
        'flex min-w-0 items-center gap-1.5 truncate font-mono text-[11px] text-muted-foreground',
        (dock.error() || dock.phase() === 'error') && 'text-error',
        recording() && 'text-error',
        dock.phase() === 'speaking' && 'text-brand',
        props.class,
      )}
      data-voice-phase={dock.phase()}
    >
      <Show when={recording()}>
        <span class="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-error" />
      </Show>
      <Show when={working() && !dock.error()} fallback={<span class="truncate">{text()}</span>}>
        <Shimmer>{text()}</Shimmer>
      </Show>
    </output>
  )
}

function holdHandlers() {
  return {
    onPointerDown: (event: PointerEvent) => {
      event.preventDefault()
      void press()
    },
    onPointerLeave: () => void release(),
    onPointerUp: () => void release(),
  }
}

const holdTitle = () =>
  `Hold to talk · or hold Space outside a text field, ${holdKeys()} anywhere · ${keys()} hides Voice`

function TalkBar() {
  return (
    <Button
      aria-label="Hold to talk"
      class={cn(
        'relative flex h-9 w-full touch-none items-center gap-2.5 overflow-hidden rounded-lg border border-border/70 bg-muted/30 px-3 font-normal text-muted-foreground transition-colors select-none hover:border-ring/50 hover:bg-muted/50',
        recording() && 'border-error/40 bg-error/5 hover:border-error/40 hover:bg-error/5',
        dock.phase() === 'speaking' && 'border-brand/30',
      )}
      size={null}
      title={holdTitle()}
      variant={null}
      {...holdHandlers()}
    >
      <Mic class={cn('size-3.5 shrink-0', recording() && 'text-error')} />
      <Show when={recording()} fallback={<Status class="flex-1" />}>
        <Status class="shrink-0" />
        <Waveform class="h-5 min-w-0 flex-1 text-error" live />
      </Show>
      <Show when={!recording()}>
        <span class="ml-auto flex shrink-0 items-center gap-1 font-mono text-[11px] whitespace-nowrap text-muted-foreground/70 pointer-coarse:hidden">
          <Kbd>Space</Kbd>
          <span class="text-muted-foreground/40">/</span>
          <Kbd>{holdKeys()}</Kbd>
        </span>
      </Show>
    </Button>
  )
}

function Settings(props: { model?: boolean }) {
  return (
    <Popover>
      <PopoverTrigger aria-label="Voice settings" class={iconButton} title="Voice settings">
        <Settings2 class="size-4" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Voice settings options"
        class="w-64 p-0 font-mono text-[11.5px]"
        side="top"
      >
        <div class="px-3 pt-2.5 pb-1 section-label">Voice</div>
        <Show when={props.model}>
          <div class="px-1.5 pb-1">
            <VoiceModel class={cn(toolbarButton, 'w-full max-w-none')} />
          </div>
        </Show>
        <div class="flex flex-col gap-2.5 border-t border-border/60 px-3 py-2.5 text-muted-foreground">
          <label class="flex items-center justify-between gap-3">
            Speak replies
            <Toggle aria-label="Speak replies" bind={[dock.speak, dock.setSpeak]} />
          </label>
          <label class="flex items-center justify-between gap-3">
            Sound cues
            <Toggle aria-label="Voice sound cues" bind={[dock.cuesOn, dock.setCuesOn]} />
          </label>
          <label class="flex items-center justify-between gap-3">
            Speed
            <span class="flex items-center gap-2">
              <Slider
                aria-label="Speech speed"
                bind={[dock.rate, dock.setRate]}
                class="w-24"
                max={2}
                min={0.8}
                step={0.05}
              />
              <span class="w-9 text-right text-foreground/85 tabular-nums">
                {dock.rate().toFixed(2)}×
              </span>
            </span>
          </label>
          <div class="flex items-center justify-between gap-3">
            Talk anywhere
            <ShortcutRecorder />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ShortcutRecorder() {
  const [listening, setListening] = createSignal(false)
  const record = (event: KeyboardEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      setListening(false)
      return
    }
    const chord = keyChord(event)
    const hasKey = !['mod', 'ctrl', 'alt', 'shift'].includes(chord.split('+').at(-1)!)
    const hasModifier = chord.includes('+')
    if (!hasKey || !hasModifier) return
    dock.setHoldKeys(chord)
    setListening(false)
  }
  return (
    <Button
      aria-label="Talk anywhere shortcut"
      class={cn(
        'flex h-6 items-center gap-1 rounded-md border border-border/70 px-1.5 font-mono text-[11px] font-normal text-foreground/85 hover:bg-accent',
        listening() && 'border-brand/60 text-brand',
      )}
      onBlur={() => setListening(false)}
      onClick={() => setListening(true)}
      onKeyDown={(event: KeyboardEvent) => listening() && record(event)}
      size={null}
      title="Click, then press a key with a modifier (Ctrl, Alt, Shift); Esc cancels"
      variant={null}
    >
      {listening() ? 'press keys…' : holdKeys()}
    </Button>
  )
}

function PlaybackStrip() {
  const state = useExternal(dock.player.state.get, dock.player.state.subscribe)
  const [now, setNow] = createSignal(Date.now())
  createEffect(
    () => state().playing,
    (on) => (on ? every(200, () => setNow(Date.now())) : undefined),
  )
  const progress = createMemo(() => {
    const list = dock.player.items()
    const current = list[state().index]
    if (!current) return { done: 0, total: 1, paragraphs: 1, paragraph: 0 }
    const total = list.reduce((sum, item) => sum + estimate(item.text, dock.rate()), 0)
    const done =
      list
        .slice(0, state().index)
        .reduce((sum, item) => sum + estimate(item.text, dock.rate()), 0) +
      (state().playing
        ? Math.min(estimate(current.text, dock.rate()), (now() - state().startedAt) / 1000)
        : 0)
    return {
      done,
      total,
      paragraphs: new Set(list.map((item) => item.paragraph)).size,
      paragraph: current.paragraph,
    }
  })
  const step = (label: string, icon: JSX.Element, run: () => void) => (
    <Button
      aria-label={label}
      class={rowButton}
      onClick={() => run()}
      size={null}
      title={label}
      variant={null}
    >
      {icon}
    </Button>
  )
  return (
    <Show when={state().playing || state().paused}>
      <div
        class="relative flex min-w-0 items-center gap-2 overflow-hidden rounded-lg border border-border/70 bg-muted/30 px-2.5 py-1 font-mono text-[11px] text-muted-foreground"
        data-voice-playback
      >
        <AudioLines class="size-3.5 shrink-0 text-brand" />
        <span class="min-w-0 truncate tabular-nums">
          {state().paused ? 'Paused' : 'Speaking'} · ¶ {progress().paragraph + 1}/
          {progress().paragraphs}
          {state().streaming ? '+' : ''} · {state().index + 1}/{dock.player.items().length} · ~
          {Math.max(0, Math.round(progress().total - progress().done))} s
          {state().streaming ? ' · still writing' : ''}
        </span>
        <span class="ml-auto flex shrink-0 items-center gap-1">
          {step('Previous paragraph', <SkipBack />, () => dock.player.paragraph(-1))}
          {step('Previous sentence', <ChevronLeft />, () => dock.player.sentence(-1))}
          {step(
            state().playing ? 'Pause speech' : 'Resume speech',
            state().playing ? <Pause /> : <Play />,
            () => dock.player.toggle(),
          )}
          {step('Next sentence', <ChevronRight />, () => dock.player.sentence(1))}
          {step('Next paragraph', <SkipForward />, () => dock.player.paragraph(1))}
        </span>
        <i
          aria-hidden="true"
          class="absolute bottom-0 left-0 h-px bg-brand/70 transition-[width] duration-200 ease-linear"
          style={{
            width: `${Math.min(100, (progress().done / progress().total) * 100)}%`,
          }}
        />
      </div>
    </Show>
  )
}

function Bottom(props: { fork: ConversationId | undefined }) {
  const target = (): ComposerTarget => ({
    placeholder: 'Type, paste a screenshot, or hold Space to talk…',
    images: true,
    send: (text, images) => sendTyped(text, images),
  })
  return (
    <footer class="flex shrink-0 flex-col gap-1.5 pt-1" data-voice-bottom>
      <div class="flex flex-col gap-1.5 px-4">
        <PlaybackStrip />
        <TalkBar />
      </div>
      <Show
        when={props.fork}
        fallback={
          <div class="flex items-center gap-2 px-4 pb-3 font-mono text-[11px] text-muted-foreground">
            <Shimmer>forking @ultimate…</Shimmer>
          </div>
        }
      >
        {(fork) => (
          <ScopedConversation id={fork()}>
            <ComposerRedirect value={target}>
              <Composer dock />
            </ComposerRedirect>
          </ScopedConversation>
        )}
      </Show>
    </footer>
  )
}

export function VoicePanel() {
  const session = useDocOf(() => ROOT, VoiceSessionDoc)
  const fork = useDocOf(() => session()?.id, VoiceForkDoc)
  const viewport = useViewport()
  const id = () => session()?.id
  const surface = useSurface()
  const shown = useConversationId()
  const summary = useConversationSummary(shown)
  createEffect(
    () => [surface(), shown(), summary()?.title] as const,
    ([on, conversation, title]) => {
      setScreen(
        `Daniel's screen: the ${on} surface${
          on === 'agent' && conversation !== undefined
            ? `, showing conversation #${conversation}${title ? ` "${title}"` : ''}`
            : ''
        }.`,
      )
    },
  )
  onSettled(() => {
    let holding: string | undefined
    const down = (event: KeyboardEvent) => {
      if (holding !== undefined) {
        if (event.code === holding || event.repeat) {
          event.preventDefault()
          event.stopPropagation()
        }
        return
      }
      if (event.repeat) return
      const field =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('input, textarea, select, [contenteditable="true"]')
          : null
      const emptyVoiceBox =
        field instanceof HTMLTextAreaElement &&
        !!field.closest('[data-voice-panel]') &&
        !field.value.trim()
      const chord = keyChord(event)
      const space = chord === 'space' && voiceOpen() && (!field || emptyVoiceBox)
      if (!space && chord !== parseHold()) return
      event.preventDefault()
      event.stopPropagation()
      holding = event.code
      if (!voiceOpen()) setVoiceOpen(true)
      void press().then(() => {
        if (holding === undefined) void release()
      })
    }
    const up = (event: KeyboardEvent) => {
      if (holding === undefined) return
      const modifier = ['Meta', 'Control', 'Shift', 'Alt'].includes(event.key)
      if (event.code !== holding && !modifier) return
      event.preventDefault()
      event.stopPropagation()
      holding = undefined
      void release()
    }
    window.addEventListener('keydown', down, { capture: true })
    window.addEventListener('keyup', up, { capture: true })
    return () => {
      window.removeEventListener('keydown', down, { capture: true })
      window.removeEventListener('keyup', up, { capture: true })
    }
  })
  const phone = () => viewport() === 'phone'
  const [place, setPlace] = useExtensionUiState<{ right: number; bottom: number } | null>(
    'corner',
    null,
  )
  const [folded, setFolded] = useExtensionUiState('folded', false)
  const drag = (event: PointerEvent & { currentTarget: HTMLElement }) => {
    if (phone() || (event.target as HTMLElement).closest('button')) return
    const panel = event.currentTarget.closest<HTMLElement>('[data-voice-panel]')!
    const box = panel.getBoundingClientRect()
    const right = window.innerWidth - box.right
    const bottom = window.innerHeight - box.bottom
    const x = event.clientX
    const y = event.clientY
    event.currentTarget.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent) =>
      setPlace({
        right: Math.max(8, Math.min(window.innerWidth - box.width - 8, right - (next.clientX - x))),
        bottom: Math.max(8, Math.min(window.innerHeight - 48, bottom - (next.clientY - y))),
      })
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const style = () => {
    const at = place()
    if (phone() || !at) return undefined
    const height = folded() ? '6rem' : 'min(44rem, 100vh - 5rem)'
    return {
      right: `min(${at.right}px, 100vw - min(36rem, 46vw) - 0.5rem)`,
      bottom: `min(${at.bottom}px, 100vh - ${height} - 3rem)`,
    }
  }
  return (
    <Show when={voiceOpen()}>
      <section
        aria-label="Voice"
        class={cn(
          'pointer-events-auto fixed z-40 flex flex-col overflow-hidden border border-border bg-background shadow-2xl shadow-black/40',
          phone()
            ? folded()
              ? 'inset-x-2 bottom-2 rounded-xl'
              : 'inset-x-0 top-11 bottom-0 rounded-t-2xl border-b-0'
            : folded()
              ? 'right-4 bottom-4 w-[min(26rem,46vw)] rounded-xl'
              : 'right-4 bottom-4 h-[min(44rem,calc(100vh-5rem))] w-[min(36rem,46vw)] rounded-xl',
        )}
        data-voice-folded={folded() || undefined}
        data-voice-panel
        style={style()}
      >
        <header
          class={cn(
            'flex h-10 shrink-0 touch-none items-center gap-2 border-b border-border/60 px-3 select-none',
            !phone() && 'cursor-grab active:cursor-grabbing',
            folded() && 'border-b-0',
          )}
          onDblClick={() => setFolded(!folded())}
          onPointerDown={drag}
          title={phone() ? undefined : 'Drag to move · double-click to fold'}
        >
          <AudioLines class="size-3.5 shrink-0 text-brand" />
          <span class="text-[13px] font-semibold">Voice</span>
          <Show when={!folded()}>
            <span class="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
              {id()
                ? `hot · fork of @ultimate${fork()?.of ? ` #${fork()!.of}` : ''} · #${id()}`
                : 'cold · forks @ultimate when you talk'}
            </span>
          </Show>
          <span class="ml-auto flex shrink-0 items-center gap-1">
            <Settings model />
            <Show when={!folded()}>
              <Show when={id()}>
                <Button
                  aria-label="Open the voice conversation"
                  class="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => switchConversation(id()!)}
                  size={null}
                  title="Open the voice conversation"
                  variant={null}
                >
                  <SquareArrowOutUpRight class="size-3.5" />
                </Button>
                <Button
                  aria-label="End voice session"
                  class="h-7 rounded-md px-2 font-mono text-[11px] font-normal text-muted-foreground hover:bg-error/10 hover:text-error"
                  onClick={() => endSession()}
                  size={null}
                  title="End the session: the fork concludes and the next turn forks @ultimate again"
                  variant={null}
                >
                  end
                </Button>
              </Show>
            </Show>
            <Button
              aria-label={folded() ? 'Unfold voice' : 'Fold voice'}
              class="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setFolded(!folded())}
              size={null}
              title={folded() ? 'Unfold' : 'Fold'}
              variant={null}
            >
              <Show when={folded()} fallback={<Minimize2 class="size-3.5" />}>
                <Maximize2 class="size-3.5" />
              </Show>
            </Button>
            <Button
              aria-label="Close voice"
              class="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setVoiceOpen(false)}
              size={null}
              title={`Close · ${keys()}`}
              variant={null}
            >
              <X class="size-3.5" />
            </Button>
          </span>
        </header>
        <Show when={id()}>
          {(open) => (
            <ScopedConversation id={open()}>
              <Voicing fork={open()} />
            </ScopedConversation>
          )}
        </Show>
        <Show
          when={!folded()}
          fallback={
            <div class="px-2 pb-2">
              <TalkBar />
            </div>
          }
        >
          <Show
            when={id()}
            fallback={
              <div class="flex flex-1 flex-col items-center justify-center gap-1.5 px-10 text-center">
                <AudioLines class="mb-1 size-5 text-brand" />
                <p class="text-[14px] text-foreground">Think out loud with @ultimate</p>
                <p class="max-w-sm text-[13px] text-muted-foreground">
                  Hold <Kbd>Space</Kbd> here, or <Kbd>{holdKeys()}</Kbd> anywhere, and talk. Voice
                  forks @ultimate with everything it knows, talks it through with you, and hands the
                  result back when you agree; then the next talk starts fresh.
                </p>
              </div>
            }
          >
            {(open) => (
              <ScopedConversation id={open()}>
                <Session fork={open()} />
              </ScopedConversation>
            )}
          </Show>
          <Bottom fork={id()} />
        </Show>
      </section>
    </Show>
  )
}

export function VoiceToggle() {
  const session = useDocOf(() => ROOT, VoiceSessionDoc)
  return (
    <Button
      aria-label={voiceOpen() ? 'Hide voice' : 'Open voice'}
      class={cn(
        'flex h-6 items-center gap-1.5 rounded-md px-1.5 font-mono text-[11px] font-normal text-muted-foreground hover:bg-accent hover:text-foreground',
        session()?.id !== undefined && 'text-brand',
      )}
      onClick={() => setVoiceOpen(!voiceOpen())}
      size={null}
      title={`Voice · ${keys()}`}
      variant={null}
    >
      <AudioLines class="size-3.5" />
      <Show when={session()?.id !== undefined}>
        <span class="size-1.5 rounded-full bg-brand motion-safe:animate-pulse" />
      </Show>
      voice
    </Button>
  )
}
