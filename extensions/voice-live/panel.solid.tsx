import {
  AudioLines,
  Check,
  LoaderCircle,
  CircleDashed,
  Maximize2,
  Minimize2,
  Settings2,
  SquareArrowOutUpRight,
  X,
} from '@lucide/solid'
import type { ConversationId } from '@earendil-works/pi-durable'
import { createEffect, createMemo, For, onSettled, Show } from 'solid-js'
import { Shimmer } from '@/components/ai/shimmer.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import { Kbd } from '@/components/ui/kbd.solid.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import { Slider } from '@/components/ui/slider.solid.tsx'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control.solid.tsx'
import { Switch as Toggle } from '@/components/ui/switch.solid.tsx'
import {
  api,
  cn,
  Composer,
  ComposerRedirect,
  ConversationTranscript,
  composerDraft,
  PromptBox,
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
import { shortcut, talkMode } from '../dictation/ui.solid.tsx'
import {
  activity,
  COLD_DRAFT,
  coldHolds,
  composeIn,
  discardDraft,
  dock,
  playerState,
  draftOf,
  endSession,
  KEYS,
  registerVoiceFallback,
  sendDraft,
  sendTyped,
  setScreen,
  setVoiceOpen,
  voiceOpen,
  voiceSink,
} from './dock.solid.tsx'
import { PickAction, StatusAction, VoiceForkDoc, VoiceSessionDoc } from './refs.ts'
import { PickControl } from '../models/ui.solid.tsx'
import type { ModelPick } from '../models/ui.solid.tsx'
import { PlaybackBar, SpeakerBar, speech, VOICES } from '../read-aloud/ui.solid.tsx'

import { Voicing, Waveform } from './turns.solid.tsx'

const iconButton =
  'flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-open:bg-accent data-open:text-foreground pointer-coarse:size-9'
const keys = () => formatKeys(KEYS)[0].join('+')
const holdKeys = () => formatKeys(shortcut())[0].join('+')
const tap = () => talkMode() === 'tap'
const talkVerb = () => (tap() ? 'tap' : 'hold')

const recording = () => dock.capturing()
const working = () => dock.phase() === 'sending' || dock.phase() === 'thinking'

function Status(props: { class?: string }) {
  const text = () =>
    dock.error() ?? (audible() && dock.status() === 'Speaking' ? undefined : dock.status())
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
        <Shimmer>{text() ?? ''}</Shimmer>
      </Show>
    </output>
  )
}

function SpokenParagraph() {
  const state = playerState
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

function VoiceLine(props: { words?: boolean }) {
  const spoken = () => props.words && (playerState().playing || playerState().paused)
  const shown = () =>
    recording() ||
    spoken() ||
    !!activity().current ||
    !!dock.error() ||
    !!(dock.status() && !(audible() && dock.status() === 'Speaking')) ||
    draftOf().length > 0
  return (
    <Show when={shown()}>
      <div
        class="flex min-h-6 min-w-0 items-center gap-2 px-1 font-mono text-[11px] text-muted-foreground"
        data-voice-line
      >
        <Show
          when={recording()}
          fallback={
            <Show
              when={spoken()}
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
          <Waveform class="h-4 min-w-0 flex-1 text-error" live />
        </Show>
        <Show when={!recording() && draftOf().length}>
          <span class="flex shrink-0 items-center gap-1 rounded-full bg-brand/15 px-1.5 text-[10.5px] text-brand">
            <span class="size-1.5 rounded-full bg-brand motion-safe:animate-pulse" />
            {draftOf().length} collected
          </span>
        </Show>
      </div>
    </Show>
  )
}

const glow = `@keyframes voice-glow {
  0%, 100% { box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.4), 0 0 18px 0 color-mix(in oklab, var(--color-brand) 14%, transparent); }
  50% { box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.4), 0 0 36px 4px color-mix(in oklab, var(--color-brand) 30%, transparent); }
}`

const audible = () => playerState().playing

function Settings() {
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
        <div class="flex flex-col gap-2.5 px-3 pt-1 pb-2.5 text-muted-foreground">
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
                bind={[speech.rate, speech.setRate]}
                class="w-24"
                max={2}
                min={0.8}
                step={0.05}
              />
              <span class="w-9 text-right text-foreground/85 tabular-nums">
                {speech.rate().toFixed(2)}×
              </span>
            </span>
          </label>
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
  const keyed = () => speech.keyed() === true
  const voiceNote = () => {
    const needsKey = speech.keyed() === false && 'OpenAI voice needs OPENAI_API_KEY in ⌘K → Secrets'
    if (speech.voiced()) return needsKey
    if (needsKey) return `No system voices in this browser. ${needsKey}`
    return keyed() && 'No system voices in this browser · speaking with OpenAI'
  }
  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between gap-3">
        Voice
        <SegmentedControl
          aria-label="Speech voice"
          bind={[() => (speech.openaiOn() ? 'openai' : 'system'), speech.setVoice]}
        >
          <SegmentedControlItem disabled={!speech.voiced()} value="system">
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
      <Show when={speech.openaiOn()}>
        <SegmentedControl
          aria-label="OpenAI voice"
          bind={[speech.openaiVoice, speech.setOpenaiVoice]}
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

function PlaybackStrip() {
  return (
    <Show
      when={playerState().playing || playerState().paused}
      fallback={<SpeakerBar name="Voice dock" />}
    >
      <PlaybackBar
        name="Voice dock"
        status={playerState().paused ? 'Paused' : 'Speaking'}
        toggle={() => speech.toggle()}
      />
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

function useVoicePick(): ModelPick {
  const session = useDocOf(() => ROOT, VoiceSessionDoc)
  const status = useAction(StatusAction, null, {
    conversation: ROOT,
    on: () => [session()?.id, session()?.model, session()?.thinking],
  })
  const ref = () => {
    const model = status.data()?.model
    if (!model) return undefined
    const at = model.indexOf('/')
    return { provider: model.slice(0, at), modelId: model.slice(at + 1) }
  }
  return {
    name: 'Voice',
    ref,
    thinking: () => status.data()?.thinking,
    configure: async (change) => {
      await api.action(PickAction, change, { conversationId: ROOT })
      await status.refetch()
    },
  }
}

function Bottom(props: { fork: ConversationId | undefined; fold: boolean }) {
  const chip = <PickControl pick={useVoicePick()} />
  const idle = () => !recording() && !working() && dock.phase() !== 'recording'
  const showChip = () => props.fork === undefined && idle()
  const coldHeld = useExternal(
    () => coldHolds(composerDraft(COLD_DRAFT)),
    (notify) => composerDraft(COLD_DRAFT).subscribe(notify),
  )
  const hot = () => (coldHeld() ? undefined : props.fork)
  const placeholder = () => `Type, paste a screenshot, or ${talkVerb()} ${holdKeys()} to talk…`
  const target = (): ComposerTarget => ({
    name: 'Voice dock',
    placeholder: placeholder(),
    images: true,
    dictation: voiceSink,
    ready: () => draftOf().length > 0,
    send: (text, images) => sendTyped(text, images),
    ...(hot() === undefined ? { draft: COLD_DRAFT, toolbar: showChip() ? chip : undefined } : {}),
  })
  return (
    <Show
      when={!props.fold}
      fallback={
        <footer class="flex shrink-0 flex-col gap-1 px-2 pb-2">
          <VoiceLine words />
          <PromptBox
            accepts={{ images: true }}
            conversation={hot()}
            dictation={voiceSink}
            draft={hot() ?? COLD_DRAFT}
            minimal
            name="Voice dock"
            onSubmit={(input) => sendTyped(input.text, input.images)}
            placeholder={`Talk (${holdKeys()}) or type…`}
            ready={() => draftOf().length > 0}
          />
        </footer>
      }
    >
      <footer class="flex shrink-0 flex-col gap-1.5 pt-1">
        <div class="flex flex-col gap-1.5 px-4">
          <PlaybackStrip />
          <Collected fork={props.fork} />
          <VoiceLine />
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
    </Show>
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
      if (known !== undefined) speech.setKeyed(known)
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
  onSettled(registerVoiceFallback)
  const phone = () => viewport() === 'phone'
  const [place, setPlace] = useExtensionUiState<{
    right: number
    bottom: number
  } | null>('corner', null)
  const [folded, setFolded] = useExtensionUiState('folded', false)
  const drag = (event: PointerEvent & { currentTarget: HTMLElement }) => {
    if (phone() || (event.target as HTMLElement).closest('button, [popover]')) return
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
              ? 'right-3 bottom-[calc(9rem+env(safe-area-inset-bottom))] left-3 rounded-xl'
              : 'inset-x-0 top-11 bottom-0 rounded-t-2xl border-b-0'
            : folded()
              ? 'right-4 bottom-4 w-[min(26rem,46vw)] rounded-xl'
              : 'right-4 bottom-4 h-[min(44rem,calc(100vh-5rem))] w-[min(36rem,46vw)] rounded-xl',
          audible() && 'border-brand/50 motion-safe:animate-[voice-glow_2.8s_ease-in-out_infinite]',
        )}
        data-voice-folded={folded() || undefined}
        data-voice-panel
        data-voice-speaking={audible() || undefined}
        style={style()}
      >
        <style>{glow}</style>
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
            <Settings />
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
        <Show when={!folded()}>
          <Show
            when={id()}
            fallback={
              <div class="flex flex-1 flex-col items-center justify-center gap-1.5 px-10 text-center">
                <AudioLines class="mb-1 size-5 text-brand" />
                <p class="text-[14px] text-foreground">Think out loud with @ultimate</p>
                <p class="max-w-sm text-[13px] text-muted-foreground">
                  Use the mic below, or {talkVerb()} <Kbd>{holdKeys()}</Kbd> when no other prompt
                  box is focused. Voice forks @ultimate with everything it knows, talks it through
                  with you, and hands the result back when you agree; then the next talk starts
                  fresh.
                </p>
                <SetupList />
              </div>
            }
          >
            {(open) => (
              <ScopedConversation id={open()}>
                <ConversationTranscript dock />
              </ScopedConversation>
            )}
          </Show>
        </Show>
        <Bottom fold={folded()} fork={id()} />
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
