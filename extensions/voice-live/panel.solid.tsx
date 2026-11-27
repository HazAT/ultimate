import {
  AudioLines,
  Check,
  LoaderCircle,
  CircleDashed,
  Maximize2,
  Minimize2,
  Play,
  Settings2,
  SquareArrowOutUpRight,
  X,
} from '@lucide/solid'
import type { ConversationId } from '@earendil-works/pi-durable'
import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  onCleanup,
  onSettled,
  Show,
} from 'solid-js'
import { Shimmer } from '@/components/ai/shimmer.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import { Kbd } from '@/components/ui/kbd.solid.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import { Switch as Toggle } from '@/components/ui/switch.solid.tsx'
import {
  api,
  cn,
  column,
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
import type { ComposerTarget, SolidComposerProps } from '@/sdk/solid'
import type { JSX } from '@solidjs/web'
import { DictationOptions, shortcut, talkMode } from '../dictation/ui.solid.tsx'
import { ModeSwitch, TalkBar } from './talk.solid.tsx'
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
import {
  PlaybackBar,
  SOUND_BLOCKED,
  SpeakerBar,
  speech,
  SpeechOptions,
} from '../read-aloud/ui.solid.tsx'

import { Voicing, Waveform } from './turns.solid.tsx'
import { REST, settle, type Snap } from './sheet.web.ts'

const FULL_TOP = 36
const [sheetRoom, setSheetRoom] = createRoot(() => createSignal(0))

export function SheetComposer(props: SolidComposerProps) {
  const viewport = useViewport()
  return (
    <Show when={!props.dock} fallback={props.core}>
      <Show
        when={!voiceOpen()}
        fallback={
          <Show when={viewport() === 'phone'} fallback={props.core}>
            <div aria-hidden="true" data-voice-sheet-room style={{ height: `${sheetRoom()}px` }} />
          </Show>
        }
      >
        <TalkOrType onTalk={() => setVoiceOpen(true)}>{props.core}</TalkOrType>
      </Show>
    </Show>
  )
}

function TalkOrType(props: { onTalk?: () => void; children: JSX.Element; dock?: boolean }) {
  return (
    <Show
      when={dock.talking()}
      fallback={
        <div class="flex flex-col">
          <div class={cn('flex justify-end pb-1.5', column(props.dock))}>
            <ModeSwitch onToggle={dock.setTalking} talking={false} />
          </div>
          {props.children}
        </div>
      }
    >
      <div class={cn('pb-2', column(props.dock))}>
        <TalkBar onTalk={props.onTalk} settings={<Settings name="Talk bar settings" />} />
      </div>
    </Show>
  )
}

const iconButton =
  'flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-open:bg-accent data-open:text-foreground pointer-coarse:size-9'
const keys = () => formatKeys(KEYS).join('+')
const holdKeys = () => formatKeys(shortcut()).join('+')
const tap = () => talkMode() === 'tap'
const talkVerb = () => (tap() ? 'tap' : 'hold')

const capturing = () => dock.capturing()
const recording = () => capturing()
const working = () => dock.phase() === 'sending' || dock.phase() === 'thinking'

function Status(props: { class?: string }) {
  const text = () => dock.error() ?? (speaking() ? undefined : dock.status())
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

function Unblock() {
  return (
    <Button
      aria-label="Play the voice dock's reply"
      class="h-6 min-w-0 justify-start gap-1.5 rounded-md px-1.5 font-mono text-[11px] font-normal text-brand hover:bg-brand/10"
      onClick={() => speech.resume()}
      size={null}
      variant={null}
    >
      <Play class="size-3 shrink-0" />
      <span class="truncate">{SOUND_BLOCKED}</span>
    </Button>
  )
}

function VoiceLine(props: { words?: boolean }) {
  const spoken = () => props.words && (playerState().playing || playerState().paused)
  const blocked = () => playerState().blocked
  const listening = () => capturing() && !dock.talking()
  const shown = () =>
    blocked() ||
    listening() ||
    spoken() ||
    !!activity().current ||
    (!!dock.error() && !dock.talking()) ||
    !!(dock.status() && !speaking() && !dock.talking()) ||
    (draftOf().length > 0 && !(dock.talking() && capturing()))
  return (
    <Show when={shown()}>
      <div
        class="flex min-h-6 min-w-0 items-center gap-2 px-1 font-mono text-[11px] text-muted-foreground"
        data-voice-line
      >
        <Show
          when={listening()}
          fallback={
            <Show
              when={!blocked() && spoken()}
              fallback={
                <Show when={!blocked()} fallback={<Unblock />}>
                  <Show
                    when={activity().current}
                    fallback={
                      <Show when={!dock.talking()}>
                        <Status class="flex-1" />
                      </Show>
                    }
                  >
                    <Working />
                  </Show>
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
const speaking = () =>
  dock.status() === 'Speaking' && (playerState().playing || playerState().paused)

function Settings(props: { name?: string }) {
  const name = () => props.name ?? 'Voice settings'
  return (
    <Popover>
      <PopoverTrigger aria-label={name()} class={iconButton} title="Voice settings">
        <Settings2 class="size-4" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={`${name()} options`}
        class="max-h-[70dvh] w-64 overflow-y-auto p-0 font-mono text-[11.5px]"
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
          <SpeechOptions name={name()} />
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
        <DictationOptions name={props.name ?? 'Voice'} />
      </PopoverContent>
    </Popover>
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
        status={
          playerState().blocked ? SOUND_BLOCKED : playerState().paused ? 'Paused' : 'Speaking'
        }
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
  const useDefault = async () => {
    await api.action(PickAction, { model: null }, { conversationId: ROOT })
    await status.refetch()
  }
  const items = () => {
    const data = status.data()
    const setup = data?.setup
    return setup
      ? [
          {
            label: 'Model',
            ...setup.model,
            ...(data.source === 'picked' ? { reset: true } : {}),
          },
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
                <Show when={'reset' in item}>
                  <Button
                    aria-label="Use default"
                    class="h-6 self-start rounded-md px-2 font-mono text-[11px] font-normal"
                    onClick={useDefault}
                    size={null}
                    variant="outline"
                  >
                    Use default
                  </Button>
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
  const viewport = useViewport()
  const placeholder = () =>
    viewport() === 'phone'
      ? `Type, paste, or ${talkVerb()} to talk…`
      : `Type, paste a screenshot, or ${talkVerb()} ${holdKeys()} to talk…`
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
          <Show
            when={!dock.talking()}
            fallback={<TalkBar settings={<Settings name="Talk bar settings" />} />}
          >
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
            <div class="flex justify-end">
              <ModeSwitch onToggle={dock.setTalking} talking={false} />
            </div>
          </Show>
        </footer>
      }
    >
      <footer class="flex shrink-0 flex-col gap-1.5 pt-1">
        <div class="flex flex-col gap-1.5 px-4">
          <PlaybackStrip />
          <Collected fork={props.fork} />
          <VoiceLine />
        </div>
        <TalkOrType dock>
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
        </TalkOrType>
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
        text: `The user's screen: the ${on} surface${
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
  const [desktopFolded, setDesktopFolded] = useExtensionUiState('folded', false)
  const [snapped, setSnap] = useExtensionUiState<Snap>('sheet', 'rest')
  const snap = () => snapped() as Snap
  const [dragged, setDragged] = createSignal<number>()
  const folded = () => (phone() ? snap() === 'folded' : desktopFolded())
  const setFolded = (fold: boolean) =>
    phone() ? setSnap(fold ? 'folded' : 'rest') : setDesktopFolded(fold)
  let sheet: HTMLElement | undefined
  let observer: ResizeObserver | undefined
  onCleanup(() => observer?.disconnect())
  const measure = (element: HTMLElement) => {
    observer?.disconnect()
    observer = new ResizeObserver(() => {
      const line = document.querySelector<HTMLElement>('[data-ui="status-line"]')
      const room = element.offsetHeight - (line?.offsetHeight ?? 0)
      setSheetRoom(Math.max(0, Math.min(room, window.innerHeight * REST)))
    })
    observer.observe(element)
  }
  let swiped = false
  let endSwipe: (() => void) | undefined
  onCleanup(() => endSwipe?.())
  const swipe = (event: PointerEvent & { currentTarget: HTMLElement }) => {
    swiped = false
    if (
      (event.target as HTMLElement).closest('button:not([data-voice-grabber]), [popover], textarea')
    )
      return
    const handle = event.currentTarget
    const finger = event.pointerId
    endSwipe?.()
    const start = sheet!.offsetHeight
    const full = sheet!.getBoundingClientRect().bottom - FULL_TOP
    const y = event.clientY
    let last = { y, at: event.timeStamp }
    let velocity = 0
    let moving = false
    const move = (next: PointerEvent) => {
      if (next.pointerId !== finger) return
      const pulled = y - next.clientY
      if (!moving && Math.abs(pulled) < 6) return
      if (!moving) handle.setPointerCapture(next.pointerId)
      moving = true
      swiped = true
      const span = next.timeStamp - last.at
      if (span > 0) velocity = (last.y - next.clientY) / span
      last = { y: next.clientY, at: next.timeStamp }
      setDragged(Math.max(72, Math.min(full, start + pulled)))
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      endSwipe = undefined
    }
    const up = (next: PointerEvent) => {
      if (next.pointerId !== finger) return
      stop()
      const height = dragged()
      setDragged(undefined)
      if (!moving || height === undefined) return
      const heights = {
        folded: 120,
        rest: window.innerHeight * REST,
        full,
      }
      setSnap(settle(snap(), height, start, velocity, heights))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    endSwipe = stop
  }
  const sheetHeight = () => {
    const px = dragged()
    if (px !== undefined) return `${px}px`
    if (snap() === 'folded') return undefined
    if (snap() === 'full') return `calc(100dvh - env(safe-area-inset-top) - ${FULL_TOP}px)`
    return `${REST * 100}dvh`
  }
  const drag = (event: PointerEvent & { currentTarget: HTMLElement }) => {
    if (phone()) return swipe(event)
    if ((event.target as HTMLElement).closest('button, [popover]')) return
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
    if (phone()) return { height: sheetHeight() }
    if (!at) return undefined
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
            ? cn(
                dragged() === undefined &&
                  'transition-[height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
                'inset-x-0 bottom-0 rounded-t-2xl border-x-0 border-b-0 border-t-brand/40 pb-[env(safe-area-inset-bottom)] has-[textarea:focus]:pb-0',
              )
            : folded()
              ? 'right-4 bottom-4 w-[min(26rem,46vw)] rounded-xl'
              : 'right-4 bottom-4 h-[min(44rem,calc(100vh-5rem))] w-[min(36rem,46vw)] rounded-xl',
          audible() && 'border-brand/50 motion-safe:animate-[voice-glow_2.8s_ease-in-out_infinite]',
        )}
        data-voice-folded={folded() || undefined}
        data-voice-panel
        data-voice-sheet={phone() ? snap() : undefined}
        data-voice-speaking={audible() || undefined}
        ref={(element) => {
          sheet = element
          measure(element)
        }}
        style={style()}
      >
        <style>{glow}</style>
        <Show when={phone()}>
          <div
            class="flex h-5 shrink-0 touch-none items-center justify-center select-none"
            onPointerDown={drag}
          >
            <Button
              aria-label={snap() === 'full' ? 'Shrink voice' : 'Expand voice'}
              class="flex h-5 w-16 items-center justify-center"
              data-voice-grabber
              onClick={() => !swiped && setSnap(snap() === 'full' ? 'rest' : 'full')}
              size={null}
              variant={null}
            >
              <span class="h-1 w-9 rounded-full bg-muted-foreground/40" />
            </Button>
          </div>
        </Show>
        <header
          class={cn(
            'flex shrink-0 touch-none items-center gap-2 border-b border-border/60 px-3 select-none',
            phone() ? 'h-9' : 'h-10',
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
              <div class="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto px-10 py-4 text-center *:first:mt-auto *:last:mb-auto">
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
        'flex h-6 items-center gap-1.5 rounded-md px-1.5 font-mono text-[11px] font-normal text-muted-foreground hover:bg-accent hover:text-foreground max-md:size-9 max-md:justify-center max-md:px-0',
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
      <span class="max-md:hidden">voice</span>
    </Button>
  )
}
