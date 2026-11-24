import {
  AudioLines,
  Check,
  LoaderCircle,
  CircleDashed,
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
import { createEffect, createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import { Shimmer } from '@/components/ai/shimmer.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import { Kbd } from '@/components/ui/kbd.solid.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import { Slider } from '@/components/ui/slider.solid.tsx'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control.solid.tsx'
import { Switch as Toggle } from '@/components/ui/switch.solid.tsx'
import {
  api,
  chordOf,
  cn,
  Composer,
  ComposerRedirect,
  composerDraft,
  formatKeys,
  ROOT,
  ScopedConversation,
  switchConversation,
  useAction,
  useEvent,
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
  activity,
  cancelRecording,
  CANCEL_LABEL,
  COLD_DRAFT,
  coldHolds,
  composeIn,
  discardDraft,
  dock,
  playerState,
  draftOf,
  endSession,
  KEYS,
  press,
  release,
  sendDraft,
  sendTyped,
  setScreen,
  setVoiceOpen,
  talking,
  voiceOpen,
} from './dock.solid.tsx'
import { createTalk } from './talk.ts'
import { ModelAction, StatusAction, VoiceForkDoc, VoiceSessionDoc } from './refs.ts'
import { VOICES } from './voices.ts'
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
const tap = () => dock.talkMode() === 'tap'
const talkVerb = () => (tap() ? 'tap' : 'hold')
const talkLabel = () => (tap() ? 'Tap to talk' : 'Hold to talk')
const parseHold = () => dock.holdKeys().trim().toLowerCase()
const keyChord = (event: KeyboardEvent) =>
  event.code === 'Space' ? chordOf(event).replace(/ $/, 'space') : chordOf(event)

const recording = () => dock.capturing()
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
  const text = () => dock.error() ?? dock.status() ?? talkLabel()
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

const talk = createTalk({
  tap,
  talking,
  press,
  release,
  cancel: cancelRecording,
  overCancel: (event) =>
    [event.relatedTarget, document.elementFromPoint(event.clientX, event.clientY)].some(
      (target) => target instanceof Element && !!target.closest(`[aria-label="${CANCEL_LABEL}"]`),
    ),
  matches: (event) => keyChord(event) === parseHold(),
  wake: () => {
    if (!voiceOpen()) setVoiceOpen(true)
  },
})

let escapeCancelled = false
window.addEventListener(
  'keydown',
  (event) => {
    if (event.key !== 'Escape') return
    if (!event.repeat) escapeCancelled = talk.cancel()
    if (!escapeCancelled) return
    event.preventDefault()
    event.stopImmediatePropagation()
  },
  { capture: true },
)
window.addEventListener(
  'keyup',
  (event) => {
    if (event.key === 'Escape') escapeCancelled = false
  },
  { capture: true },
)

const talkTitle = () =>
  recording() && tap()
    ? `Tap, or press ${holdKeys()}, to stop and send`
    : `${talkLabel()}, or ${talkVerb()} ${holdKeys()} anywhere · ${keys()} hides Voice`

function CancelRecording(props: { class?: string }) {
  return (
    <Show when={recording()}>
      <Button
        aria-label={CANCEL_LABEL}
        class={cn(
          'flex shrink-0 items-center justify-center rounded-md text-error/70 transition-colors hover:bg-error/10 hover:text-error',
          props.class,
        )}
        onClick={() => void talk.cancel()}
        size={null}
        title="Cancel recording · Esc"
        variant={null}
      >
        <X class="size-3.5" />
      </Button>
    </Show>
  )
}

function SpokenParagraph() {
  const state = useExternal(dock.player.state.get, dock.player.state.subscribe)
  const paragraph = createMemo(() => {
    const items = dock.player.items()
    const current = items[state().index]
    if (!current) return []
    return items
      .map((sentence, index) => ({ sentence, index }))
      .filter(({ sentence }) => sentence.paragraph === current.paragraph)
  })
  return (
    <span
      class="min-w-0 flex-1 py-1.5 text-left font-sans text-[13px] leading-snug whitespace-normal text-muted-foreground"
      data-voice-spoken
    >
      <For each={paragraph()}>
        {({ sentence, index }) => (
          <span
            class={cn(
              'rounded-sm transition-colors duration-300 [box-decoration-break:clone]',
              index === state().index && 'bg-brand/15 text-foreground',
            )}
          >
            {sentence.text}{' '}
          </span>
        )}
      </For>
    </span>
  )
}

function Working() {
  return (
    <span
      class="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-[11px] text-muted-foreground"
      data-voice-working
    >
      <LoaderCircle class="size-3 shrink-0 text-brand motion-safe:animate-spin" />
      <span class="min-w-0 truncate text-foreground/85">{activity().current}</span>
      <Show when={activity().done}>
        <span class="shrink-0 text-muted-foreground/70">· {activity().done} done</span>
      </Show>
    </span>
  )
}

function TalkBar(props: { words?: boolean }) {
  return (
    <div class="relative">
      <Button
        aria-label="Talk bar"
        class={cn(
          'relative flex h-auto min-h-9 w-full touch-none items-center gap-2.5 overflow-hidden rounded-lg border border-border/70 bg-muted/30 px-3 font-normal text-muted-foreground transition-colors select-none hover:border-ring/50 hover:bg-muted/50',
          recording() && 'border-error/40 bg-error/5 pr-10 hover:border-error/40 hover:bg-error/5',
          audible() && 'border-brand/40',
        )}
        size={null}
        title={talkTitle()}
        variant={null}
        {...talk.pointer}
      >
        <Mic class={cn('size-3.5 shrink-0', recording() && 'text-error')} />
        <Show
          when={recording()}
          fallback={
            <Show
              when={props.words && (playerState().playing || playerState().paused)}
              fallback={
                <Show when={activity().current} fallback={<Status class="flex-1" />}>
                  <Working />
                </Show>
              }
            >
              <SpokenParagraph />
            </Show>
          }
        >
          <Status class="shrink-0" />
          <Waveform class="h-5 min-w-0 flex-1 text-error" live />
          <Show when={tap()}>
            <span class="ml-auto flex shrink-0 items-center gap-1 font-mono text-[11px] whitespace-nowrap text-error/80">
              tap to send
            </span>
          </Show>
        </Show>
        <Show when={!recording() && draftOf().length}>
          <span class="flex shrink-0 items-center gap-1 rounded-full bg-brand/15 px-1.5 font-mono text-[10.5px] text-brand">
            <span class="size-1.5 rounded-full bg-brand motion-safe:animate-pulse" />
            {draftOf().length} collected
          </span>
        </Show>
        <Show when={!recording()}>
          <span class="ml-auto flex shrink-0 items-center gap-1 font-mono text-[11px] whitespace-nowrap text-muted-foreground/70 pointer-coarse:hidden">
            {talkVerb()} <Kbd>{holdKeys()}</Kbd>
          </span>
        </Show>
      </Button>
      <CancelRecording class="absolute top-1/2 right-1.5 size-7 -translate-y-1/2" />
    </div>
  )
}

const breathe = `@keyframes voice-breathe {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--color-brand) 0%, transparent); }
  50% { box-shadow: 0 0 0 6px color-mix(in oklab, var(--color-brand) 22%, transparent); }
}
@keyframes voice-glow {
  0%, 100% { box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.4), 0 0 18px 0 color-mix(in oklab, var(--color-brand) 14%, transparent); }
  50% { box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.4), 0 0 36px 4px color-mix(in oklab, var(--color-brand) 30%, transparent); }
}`

const audible = () => playerState().playing

function TalkButton(props: { unfold: () => void }) {
  return (
    <div class="flex items-center justify-end gap-2.5" data-voice-talk-button>
      <CancelRecording class="size-9 rounded-full border border-error/40 bg-background/95 shadow-lg shadow-black/30" />
      <Button
        aria-label="Unfold voice"
        class="h-auto max-w-[60vw] min-w-0 truncate rounded-full border border-border/70 bg-background/95 px-3 py-1.5 text-left font-mono text-[11.5px] font-normal shadow-lg shadow-black/30"
        onClick={() => props.unfold()}
        size={null}
        variant={null}
      >
        <Status class="text-[11.5px]" />
      </Button>
      <Button
        aria-label="Talk button"
        class={cn(
          'relative flex size-16 shrink-0 touch-none items-center justify-center rounded-full border border-border bg-card text-foreground shadow-xl shadow-black/40 transition-colors select-none',
          recording() && 'border-error/60 bg-error/15 text-error',
          working() && 'border-ring/60 text-muted-foreground',
          audible() &&
            'border-brand/60 text-brand motion-safe:animate-[voice-breathe_2.4s_ease-in-out_infinite]',
          (dock.error() || dock.phase() === 'error') && 'border-error/60 text-error',
        )}
        size={null}
        title={talkTitle()}
        variant={null}
        {...talk.pointer}
      >
        <Show when={recording()}>
          <span class="absolute inset-0 animate-ping rounded-full border-2 border-error/40" />
        </Show>
        <Show when={draftOf().length && !recording()}>
          <span class="absolute -top-1 -right-1 flex size-6 items-center justify-center rounded-full border-2 border-background bg-brand font-mono text-[11px] text-brand-foreground">
            {draftOf().length}
          </span>
        </Show>
        <Show when={working()}>
          <span class="absolute inset-1 animate-spin rounded-full border-2 border-transparent border-t-ring/70" />
        </Show>
        <Show when={dock.phase() === 'speaking'} fallback={<Mic class="size-6" />}>
          <AudioLines class="size-6" />
        </Show>
      </Button>
    </div>
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
          <SpeechVoice />
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
            Talk
            <SegmentedControl aria-label="Talk mode" bind={[dock.talkMode, dock.setTalkMode]}>
              <SegmentedControlItem value="hold">Hold</SegmentedControlItem>
              <SegmentedControlItem value="tap">Tap</SegmentedControlItem>
            </SegmentedControl>
          </div>
          <div class="flex items-center justify-between gap-3">
            Talk anywhere
            <ShortcutRecorder />
          </div>
          <label class="flex items-start justify-between gap-3">
            <span class="flex flex-col gap-0.5">
              Collect until send
              <span class="text-[10.5px] leading-snug text-muted-foreground/70">
                Keeps every recording; sends on Enter or when you say "send it" ("follow up" queues)
              </span>
            </span>
            <Toggle aria-label="Collect until send" bind={[dock.collect, dock.setCollect]} />
          </label>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function SpeechVoice() {
  const keyed = () => dock.keyed() === true
  const voiceNote = () => {
    const needsKey = dock.keyed() === false && 'OpenAI voice needs OPENAI_API_KEY in ⌘K → Secrets'
    if (dock.voiced()) return needsKey
    if (needsKey) return `No system voices in this browser. ${needsKey}`
    return keyed() && 'No system voices in this browser · speaking with OpenAI'
  }
  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between gap-3">
        Voice
        <SegmentedControl
          aria-label="Speech voice"
          bind={[() => (dock.openaiOn() ? 'openai' : 'system'), dock.setVoice]}
        >
          <SegmentedControlItem disabled={!dock.voiced()} value="system">
            System
          </SegmentedControlItem>
          <SegmentedControlItem disabled={!keyed()} value="openai">
            OpenAI
          </SegmentedControlItem>
        </SegmentedControl>
      </div>
      <Show when={voiceNote()}>
        {(note) => (
          <span class="text-[10.5px] leading-snug text-muted-foreground/70">{note()}</span>
        )}
      </Show>
      <Show when={dock.openaiOn()}>
        <SegmentedControl
          aria-label="OpenAI voice"
          bind={[dock.openaiVoice, dock.setOpenaiVoice]}
          class="grid grid-cols-5"
        >
          <For each={VOICES}>
            {(name) => (
              <SegmentedControlItem class="justify-center" value={name}>
                {name}
              </SegmentedControlItem>
            )}
          </For>
        </SegmentedControl>
      </Show>
    </div>
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

function Collected(props: { fork: ConversationId | undefined }) {
  const fork = useDocOf(() => props.fork, VoiceForkDoc)
  const clips = () => draftOf()
  const seconds = () => clips().reduce((sum, clip) => sum + clip.seconds, 0)
  const text = () =>
    clips()
      .map((clip) => fork()?.transcripts?.[clip.audio])
      .filter((part) => part !== undefined)
      .join(' ')
  const pending = () => clips().some((clip) => fork()?.transcripts?.[clip.audio] === undefined)
  return (
    <Show when={clips().length}>
      <div
        class="flex flex-col gap-1.5 rounded-lg border border-brand/40 bg-brand/5 px-3 py-2"
        data-voice-collected
      >
        <div class="flex items-center gap-2 font-mono text-[11px] text-brand">
          <span class="size-1.5 shrink-0 rounded-full bg-brand motion-safe:animate-pulse" />
          Collecting · {clips().length} {clips().length === 1 ? 'clip' : 'clips'} ·{' '}
          {seconds().toFixed(1)} s
          <span class="ml-auto flex items-center gap-1">
            <Button
              aria-label="Discard collected"
              class="h-6 rounded-md px-1.5 font-mono text-[11px] font-normal text-muted-foreground hover:bg-error/10 hover:text-error"
              onClick={() => discardDraft()}
              size={null}
              variant={null}
            >
              discard
            </Button>
            <Button
              aria-label="Send collected as follow-up"
              class="h-6 rounded-md px-1.5 font-mono text-[11px] font-normal text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => sendDraft('followUp')}
              size={null}
              variant={null}
            >
              follow-up
            </Button>
            <Button
              aria-label="Send collected"
              class="h-6 rounded-md bg-brand px-2 font-mono text-[11px] font-normal text-brand-foreground hover:bg-brand/90"
              onClick={() => sendDraft('steer')}
              size={null}
              variant={null}
            >
              send ↵
            </Button>
          </span>
        </div>
        <p class="text-[13px] leading-relaxed text-foreground/90">
          {text()}
          <Show when={pending()}>
            <Shimmer class="ml-1 font-mono text-[11px]">transcribing…</Shimmer>
          </Show>
        </p>
      </div>
    </Show>
  )
}

function SetupList() {
  const status = useAction(StatusAction, null, { conversation: ROOT })
  const items = () => {
    const setup = status.data()?.setup
    return setup
      ? [
          { label: 'Voice model', ...setup.model },
          { label: 'Transcription', ...setup.transcription },
          { label: 'Hands-free send', ...setup.handsFree },
        ]
      : []
  }
  return (
    <Show when={items().length}>
      <ul
        class="mt-4 flex w-full max-w-sm flex-col gap-2 rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5 text-left"
        data-voice-setup
      >
        <For each={items()}>
          {(item) => (
            <li class="flex items-start gap-2 text-[12.5px] leading-snug">
              <Show
                when={item.ready}
                fallback={<CircleDashed class="mt-0.5 size-3.5 shrink-0 text-warning" />}
              >
                <Check class="mt-0.5 size-3.5 shrink-0 text-success" />
              </Show>
              <span class="flex min-w-0 flex-col gap-0.5">
                <span class="font-mono text-[11px] text-muted-foreground">{item.label}</span>
                <span class={cn(item.ready ? 'text-foreground/90' : 'text-foreground')}>
                  {item.detail}
                </span>
                <Show when={item.fix}>
                  <span class="text-muted-foreground">{item.fix}</span>
                </Show>
              </span>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}

function Bottom(props: { fork: ConversationId | undefined }) {
  const coldHeld = useExternal(
    () => coldHolds(composerDraft(COLD_DRAFT)),
    (notify) => composerDraft(COLD_DRAFT).subscribe(notify),
  )
  const hot = () => (coldHeld() ? undefined : props.fork)
  const target = (): ComposerTarget => ({
    placeholder: `Type, paste a screenshot, or ${talkVerb()} ${holdKeys()} to talk…`,
    images: true,
    dictation: false,
    ready: () => draftOf().length > 0,
    send: (text, images) => sendTyped(text, images),
    ...(hot() === undefined ? { draft: COLD_DRAFT } : {}),
  })
  return (
    <footer class="flex shrink-0 flex-col gap-1.5 pt-1" data-voice-bottom>
      <div class="flex flex-col gap-1.5 px-4">
        <PlaybackStrip />
        <Collected fork={props.fork} />
        <TalkBar />
      </div>
      <Show
        when={hot()}
        fallback={
          <ComposerRedirect value={target}>
            <Composer dock />
          </ComposerRedirect>
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
  const status = useAction(StatusAction, null, { conversation: ROOT })
  useEvent('secrets:changed', () => void status.refetch())
  createEffect(id, (open) => {
    composeIn(open)
  })
  createEffect(
    () => status.data()?.transcribes,
    (known) => {
      if (known !== undefined) dock.setKeyed(known)
    },
  )
  createEffect(
    () => [surface(), shown(), summary()?.title] as const,
    ([on, conversation, title]) => {
      const showing = on === 'agent' ? conversation : undefined
      setScreen({
        text: `Daniel's screen: the ${on} surface${
          showing !== undefined
            ? `, showing conversation #${showing}${title ? ` "${title}"` : ''}`
            : ''
        }.`,
        ...(showing !== undefined ? { conversation: showing } : {}),
      })
    },
  )
  onSettled(() => {
    const swallow = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
    }
    const down = (event: KeyboardEvent) => {
      if (talk.keyDown(event)) swallow(event)
    }
    const up = (event: KeyboardEvent) => {
      if (talk.keyUp(event)) swallow(event)
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
              ? 'pointer-events-none right-3 bottom-[calc(9rem+env(safe-area-inset-bottom))] left-3 overflow-visible border-0 bg-transparent shadow-none [&_button]:pointer-events-auto'
              : 'inset-x-0 top-11 bottom-0 rounded-t-2xl border-b-0'
            : folded()
              ? 'right-4 bottom-4 w-[min(26rem,46vw)] rounded-xl'
              : 'right-4 bottom-4 h-[min(44rem,calc(100vh-5rem))] w-[min(36rem,46vw)] rounded-xl',
          audible() &&
            !(phone() && folded()) &&
            'border-brand/50 motion-safe:animate-[voice-glow_2.8s_ease-in-out_infinite]',
        )}
        data-voice-folded={folded() || undefined}
        data-voice-panel
        data-voice-speaking={audible() || undefined}
        style={style()}
      >
        <style>{breathe}</style>
        <header
          class={cn(
            'flex h-10 shrink-0 touch-none items-center gap-2 border-b border-border/60 px-3 select-none',
            phone() && folded() && 'hidden',
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
            <Show
              when={phone()}
              fallback={
                <div class="px-2 pb-2">
                  <TalkBar words />
                </div>
              }
            >
              <TalkButton unfold={() => setFolded(false)} />
            </Show>
          }
        >
          <Show
            when={id()}
            fallback={
              <div class="flex flex-1 flex-col items-center justify-center gap-1.5 px-10 text-center">
                <AudioLines class="mb-1 size-5 text-brand" />
                <p class="text-[14px] text-foreground">Think out loud with @ultimate</p>
                <p class="max-w-sm text-[13px] text-muted-foreground">
                  {tap() ? 'Tap' : 'Hold'} <Kbd>{holdKeys()}</Kbd> anywhere, or the talk bar, and
                  speak. Voice forks @ultimate with everything it knows, talks it through with you,
                  and hands the result back when you agree; then the next talk starts fresh.
                </p>
                <SetupList />
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
