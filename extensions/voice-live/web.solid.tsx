/** @jsxImportSource @solidjs/web */
import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import {
  AudioLinesIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  MicIcon,
  MicOffIcon,
  Minimize2Icon,
  PhoneOffIcon,
  Volume2Icon,
  XIcon,
} from '@lucide/solid'
import { createEffect, createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Kbd } from '@/components/ui/kbd.solid.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
import {
  Conversation,
  ScopedConversation,
  useProvided,
  api,
  cn,
  column,
  defineWebExtension,
  events,
  formatKeys,
  provide,
  ROOT,
  showSurface,
  switchConversation,
  useAction,
  useCommands,
  useConversation,
  useConversationId,
  useConversationSummary,
  useDocOf,
  useEvent,
  useNow,
  useSurface,
  useTranscript,
  useViewport,
  type SolidComposerProps,
} from '@/sdk/solid'
import { openQuestion } from '../../lib/message-state.ts'
import { deadline } from '../../lib/timers.ts'
import { ConversationPhase } from '../conversations/ui.solid.tsx'
import { MessagesDoc } from '../messages/refs.ts'
import { SideChatsDoc, useSideChatFront } from '../side-chat/ui.solid.tsx'
import { UnderUltimate, Unlisted } from '../sidebar/ui.solid.tsx'
import { StandingDoc } from '../subagents/refs.ts'
import { talkToUltimate } from '../subagents/ui.solid.tsx'
import { VoiceAnswerEntry, VoiceLineEntry, VoiceSessionEntry } from './entries.ts'
import * as live from './live.solid.tsx'
import type { VoiceMode } from './live.solid.tsx'
import { QuietAgentRow } from './quiet-row.solid.tsx'
import { AskedAction, LogAction, StatusAction } from './refs.ts'
import type { VoiceGo } from './refs.ts'
import {
  clock,
  ContextRow,
  HeardRow,
  LineRow,
  LiveTurn,
  QuestionRow,
  SessionRow,
  UtteranceRow,
} from './rows.solid.tsx'

const KEYS = 'alt+v'
const mode = live.mode

function useIds() {
  const standing = useDocOf(() => ROOT, StandingDoc)
  return {
    main: () => standing()?.ultimate,
    voice: () => standing()?.voice,
  }
}

function toggleFront() {
  const front = !live.voiceMode().front
  live.setFront(front)
  if (front) void talkToUltimate({ switchConversation, showSurface })
}

const keyHint = formatKeys(KEYS)[0].join(formatKeys(KEYS)[0][0] === 'Alt' ? '+' : '')

function Level(props: { class?: string; bar: string }) {
  const bars: HTMLSpanElement[] = []
  const active = createMemo(() => mode().phase === 'live' && !mode().muted)
  createEffect(active, (on) => {
    const analyser = on ? live.analyser() : undefined
    if (!analyser) {
      for (const element of bars) element.style.transform = ''
      return undefined
    }
    const samples = new Uint8Array(analyser.fftSize)
    let frame = requestAnimationFrame(function draw() {
      analyser.getByteTimeDomainData(samples)
      let sum = 0
      for (const sample of samples) sum += ((sample - 128) / 128) ** 2
      const level = Math.min(1, Math.sqrt(sum / samples.length) * 4)
      bars.forEach((element, index) => {
        const shape = [0.55, 1, 0.8, 0.45][index] ?? 1
        element.style.transform = `scaleY(${0.2 + 0.8 * level * shape})`
      })
      frame = requestAnimationFrame(draw)
    })
    return () => cancelAnimationFrame(frame)
  })
  return (
    <span
      aria-hidden="true"
      class={cn('flex items-center gap-[2px] motion-reduce:hidden', props.class)}
    >
      <For each={[0, 1, 2, 3]}>
        {(index) => (
          <span
            class={cn('h-full w-[2px] origin-center scale-y-[0.2] rounded-full', props.bar)}
            ref={(element) => {
              bars[index] = element
            }}
          />
        )}
      </For>
    </span>
  )
}

function stateLabel(state: VoiceMode) {
  if (state.phase === 'starting') return 'Connecting…'
  if (state.phase === 'ending') return 'Ending…'
  if (state.waiting) return 'Answer waiting'
  if (state.phase === 'paused') return 'Listening paused'
  return state.muted ? 'Muted' : 'Live'
}

function StartButton() {
  const id = useConversationId()
  const { main } = useIds()
  const status = useAction(StatusAction)
  useEvent('secrets:changed', () => void status.refetch())
  createEffect(status.data, (data) => {
    if (data) live.rememberStatus(data)
  })
  const missing = () => status.data()?.available === false
  const on = () => mode().phase !== 'off'
  const label = () =>
    missing()
      ? 'Voice relay needs an OpenAI API key: tap to add it'
      : on()
        ? mode().front
          ? 'Voice relay is on · send Voice back'
          : 'Voice relay is on · bring Voice to the front'
        : 'Start voice relay: talk to @ultimate, hear its answers'
  return (
    <Show when={id() !== undefined && id() === main()}>
      <Tooltip delay={400}>
        <TooltipTrigger
          aria-label={label()}
          aria-pressed={on() ? 'true' : 'false'}
          class={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground pointer-coarse:size-9',
            on() && 'bg-brand/15 text-brand hover:bg-brand/20 hover:text-brand',
            missing() && 'opacity-50 hover:bg-transparent hover:text-muted-foreground',
          )}
          data-voice-live={missing() ? 'unavailable' : mode().phase}
          onClick={() => {
            if (status.loading()) return
            if (missing()) return events.emit('secrets:open', { name: 'OPENAI_API_KEY' })
            if (on()) return toggleFront()
            void live.start()
          }}
          onPointerDown={(event) => event.preventDefault()}
          render={(trigger) => (
            <Button
              {...trigger}
              disabled={status.loading()}
              focusableWhenDisabled
              size={null}
              variant={null}
            />
          )}
        >
          <Show when={mode().phase === 'starting'} fallback={<AudioLinesIcon class="size-4" />}>
            <LoaderCircleIcon class="size-4 motion-safe:animate-spin" />
          </Show>
        </TooltipTrigger>
        <TooltipContent>{label()}</TooltipContent>
      </Tooltip>
    </Show>
  )
}

const pillButton =
  'flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring max-md:size-7'
const livePhase = () => mode().phase === 'live'

function LiveIndicator() {
  const surface = useSurface()
  const id = useConversationId()
  const viewport = useViewport()
  const now = useNow(1000, createMemo(livePhase))
  const { main } = useIds()
  const off = () => mode().phase === 'off'
  const hidden = () => !off() && surface() === 'agent' && id() === main()
  const asleep = () => mode().phase === 'paused'
  const hot = () => livePhase() && !mode().muted
  const label = () => stateLabel(mode())
  return (
    <Show when={!hidden() && (!off() || mode().problem)}>
      <Show
        when={!off()}
        fallback={
          <span
            class="flex h-6 max-w-80 items-center gap-1.5 rounded-full border border-error/40 bg-error/10 pr-0.5 pl-2.5 text-error"
            data-voice-live-indicator="failed"
            role="alert"
          >
            <span class="truncate" title={mode().problem}>
              {mode().problem}
            </span>
            <Button
              aria-label="Dismiss voice relay status error"
              class={cn(pillButton, 'text-error hover:text-error')}
              onClick={live.clearProblem}
              size={null}
              variant={null}
            >
              <XIcon class="size-3" />
            </Button>
          </span>
        }
      >
        <fieldset
          aria-label="Voice relay"
          class={cn(
            'flex h-6 min-w-0 items-center gap-0.5 rounded-full border pr-0.5 pl-1 text-foreground max-md:h-8',
            hot() ? 'border-error/40 bg-error/10' : 'border-border bg-muted/40',
            mode().waiting && 'border-brand/60 bg-brand/10',
          )}
          data-voice-live-indicator={mode().phase}
        >
          <Button
            aria-label={`${label()} · ${mode().front ? 'send Voice back' : 'bring Voice to the front'}`}
            class="flex h-full min-w-0 items-center gap-1.5 rounded-full px-1.5 text-[length:inherit] font-normal outline-none hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring"
            onClick={toggleFront}
            size={null}
            title={`${mode().front ? 'Send Voice back' : 'Bring Voice to the front'} · ${keyHint}`}
            variant={null}
          >
            <Show
              when={mode().phase === 'starting' || mode().phase === 'ending'}
              fallback={
                <span
                  class={cn(
                    'size-1.5 shrink-0 rounded-full',
                    hot() ? 'bg-error motion-safe:animate-pulse' : 'bg-muted-foreground/60',
                    mode().waiting && 'bg-brand motion-safe:animate-pulse',
                  )}
                />
              }
            >
              <LoaderCircleIcon class="size-3 shrink-0 text-muted-foreground motion-safe:animate-spin" />
            </Show>
            <span
              class={cn(
                'truncate',
                hot() ? 'text-error' : 'text-muted-foreground',
                mode().waiting && 'text-brand',
              )}
            >
              {viewport() === 'phone' && asleep() && !mode().waiting ? 'Paused' : label()}
            </span>
            <Show when={livePhase() && mode().billedSince !== undefined}>
              <span class="text-muted-foreground tabular-nums">
                {clock(now() - mode().billedSince!)}
              </span>
            </Show>
            <Show when={livePhase()}>
              <Level bar="bg-error" class="h-3" />
            </Show>
          </Button>
          <Show when={mode().problem}>
            <span
              class="max-w-48 truncate px-1 text-error max-lg:hidden"
              role="alert"
              title={mode().problem}
            >
              {mode().problem}
            </span>
          </Show>
          <Show
            when={!asleep()}
            fallback={
              <Button
                aria-label="Resume listening from the title bar"
                class="h-full shrink-0 rounded-full px-2 text-[length:inherit] font-normal text-brand outline-none hover:bg-brand/15 focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => void live.open(mode().waiting)}
                size={null}
                title="Resume listening: starts a new session"
                variant={null}
              >
                {mode().waiting ? 'Tap to hear' : 'Resume'}
              </Button>
            }
          >
            <MuteButton class={pillButton} location="title bar" />
          </Show>
          <Button
            aria-label="End voice relay from the title bar"
            class={cn(pillButton, 'hover:bg-error/15 hover:text-error')}
            onClick={live.end}
            size={null}
            title="End voice relay: closes the session"
            variant={null}
          >
            <PhoneOffIcon class="size-3.5" />
          </Button>
        </fieldset>
      </Show>
    </Show>
  )
}

function MuteButton(props: { class: string; location: string; large?: boolean; text?: boolean }) {
  return (
    <Button
      aria-label={`${mode().muted ? 'Unmute' : 'Mute'} microphone in ${props.location}`}
      aria-pressed={mode().muted ? 'true' : 'false'}
      class={cn(
        props.class,
        mode().muted &&
          (props.text ? 'border-warning/50 text-warning' : 'text-warning hover:text-warning'),
      )}
      disabled={!livePhase()}
      onClick={() => live.setMuted(!mode().muted)}
      size={null}
      title={mode().muted ? 'Unmute' : 'Mute'}
      variant={null}
    >
      <Show
        when={mode().muted !== !!props.text}
        fallback={<MicIcon class={props.large ? 'size-4' : 'size-3.5'} />}
      >
        <MicOffIcon class={props.large ? 'size-4' : 'size-3.5'} />
      </Show>
      <Show when={props.text}>{mode().muted ? 'Unmute' : 'Mute'}</Show>
    </Button>
  )
}

function Relay() {
  const { voice } = useIds()
  return (
    <Show when={mode().phase !== 'off' && voice()} keyed>
      {(id) => (
        <ScopedConversation id={id}>
          <SpeakNew />
          <Announce />
        </ScopedConversation>
      )}
    </Show>
  )
}

const questionAnnouncementQuietMs = 2000

function Announce() {
  const log = useDocOf(() => ROOT, MessagesDoc)
  let seenThisSession: Set<number> | undefined
  const [queued, setDue] = createSignal<number[]>([])
  const [quietStart, setQuietSince] = createSignal(Date.now())
  const occupied = createMemo(
    () => mode().floor !== undefined || mode().speaking !== undefined || !livePhase(),
  )
  createEffect(occupied, (busy) => {
    if (!busy) setQuietSince(Date.now())
  })
  createEffect(
    () =>
      log()
        ?.messages.filter(openQuestion)
        .map((message) => message.id),
    (open) => {
      if (!open) return
      if (!seenThisSession) {
        seenThisSession = new Set(open)
        return
      }
      const seen = seenThisSession
      const fresh = open.filter((id) => !seen.has(id))
      for (const id of fresh) seen.add(id)
      if (fresh.length) setDue((current) => [...current, ...fresh])
    },
  )
  createEffect(
    () => ({ due: queued(), busy: occupied(), quietSince: quietStart() }),
    ({ due, busy, quietSince }) => {
      if (!due.length || busy) return undefined
      return deadline(Math.max(0, quietSince + questionAnnouncementQuietMs - Date.now()), () => {
        setDue([])
        for (const message of due)
          api
            .action(AskedAction, { message })
            .catch((error: unknown) => console.warn('Voice announce failed', error))
      })
    },
  )
  return null
}

function navigate(go: VoiceGo, commands: ReturnType<ReturnType<typeof useCommands>>) {
  live.setFront(false)
  if (go.message !== undefined) return events.emit('inbox:open', { message: go.message })
  if (go.conversation !== undefined) {
    showSurface('agent')
    return switchConversation(go.conversation)
  }
  const wanted = go.surface!.trim().toLowerCase()
  const surface = commands.find(
    (command) =>
      command.id === `ultimate.surface.${wanted}` ||
      command.title.toLowerCase() === `switch to ${wanted}`,
  )
  if (surface) return showSurface(surface.id.slice('ultimate.surface.'.length))
  api
    .action(LogAction, { role: 'notice', text: `No "${go.surface}" to show here` })
    .catch((error: unknown) => console.warn('Voice notice failed', error))
}

function SpeakNew() {
  const conversation = useConversation()
  const palette = useCommands()
  const loaded = createMemo(() => (conversation().loading ? undefined : conversation().entries))
  let seenThisSession: number | undefined
  createEffect(
    () => ({ entries: loaded(), commands: palette() }),
    ({ entries, commands }) => {
      if (!entries) return
      const last = entries.at(-1)?.id ?? 0
      const lines = entries.filter((candidate) => VoiceLineEntry.is(candidate))
      live.working(
        lines.some(
          (entry) => entry.data.forwarded && !lines.some((reply) => reply.data.re === entry.id),
        ),
      )
      if (seenThisSession === undefined) {
        seenThisSession = last
        return
      }
      for (const entry of lines) {
        if (entry.id <= seenThisSession) continue
        const line = entry.data
        if (line.role === 'ultimate' && line.speech) live.hear(line.text, entry.id)
        else if (line.role === 'note') live.note(line.text)
        else if (line.role === 'action' && line.go) navigate(line.go, commands)
      }
      seenThisSession = Math.max(seenThisSession, last)
    },
  )
  return null
}

const ease = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
const duration = 420
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

function Stage() {
  const id = useConversationId()
  const { main, voice } = useIds()
  return (
    <Show when={id() !== undefined && id() === main() && voice()} keyed>
      {(voiceId) => <VoiceStage main={main()} voice={voiceId} />}
    </Show>
  )
}

function VoiceStage(props: { main?: ConversationId; voice: ConversationId }) {
  const [sideFront, setSideFront] = useSideChatFront()
  const sides = useDocOf(() => props.main, SideChatsDoc)
  const sideOpen = createMemo(
    () => !!sides()?.sides.some((side) => side.id === sideFront() && side.ended === undefined),
  )
  const viewport = useViewport()
  const phone = createMemo(() => viewport() === 'phone')
  let overlay!: HTMLDivElement
  const [width, setWidth] = createSignal(0)
  const front = createMemo(() => mode().front)
  const on = createMemo(() => mode().phase !== 'off')
  const inFront = createMemo(() => on() && front() && !sideOpen())
  createEffect(
    () => ({ front: front(), side: sideOpen() }),
    (next, previous) => {
      if (!previous) return
      if (next.front && !previous.front && next.side) setSideFront(null)
      else if (next.side && !previous.side && next.front) live.setFront(false)
    },
  )

  const [exiting, setExiting] = createSignal(false)
  createEffect(inFront, (opened) => {
    if (opened) {
      setExiting(true)
      return undefined
    }
    return deadline(duration + 60, () => setExiting(false))
  })

  onSettled(() => {
    const parent = overlay.closest<HTMLElement>('[data-ui="conversation"]')
    if (!parent) return undefined
    setWidth(parent.clientWidth)
    const observer = new ResizeObserver(() => setWidth(parent.clientWidth))
    observer.observe(parent)
    return () => observer.disconnect()
  })

  createEffect(
    () => ({ active: inFront(), width: width(), phone: phone() }),
    ({ active, width: availableWidth, phone: narrow }) => {
      const parent = overlay.closest<HTMLElement>('[data-ui="conversation"]')
      if (!parent || !active) return undefined
      const layers = [...parent.children].filter(
        (child): child is HTMLElement =>
          child instanceof HTMLElement &&
          !child.querySelector('[data-ui="conversation"]') &&
          (child.matches('[data-ui="composer"]') ||
            !!child.querySelector('[data-ui="transcript"], [data-ui="composer"]')),
      )
      const still = reduced()
      const reading = layers
        .map((layer) => layer.querySelector<HTMLElement>('[data-ui="transcript"]'))
        .find(Boolean)
      const readingColumnWidth = reading?.offsetWidth ?? availableWidth
      const scale = narrow ? 0.92 : 0.88
      const shift = narrow
        ? 0
        : Math.min(0, 24 - (availableWidth / 2 - (readingColumnWidth / 2) * scale))
      for (const layer of layers) {
        layer.style.transition = still
          ? `opacity ${duration}ms ease`
          : `transform ${duration}ms ${ease}, opacity ${duration}ms ease, filter ${duration}ms ease`
        layer.style.transformOrigin = `50% ${(narrow ? 0 : parent.clientHeight / 2) - layer.offsetTop}px`
        layer.style.transform = still
          ? ''
          : narrow
            ? `translateY(10px) scale(${scale})`
            : `translateX(${shift}px) scale(${scale})`
        layer.style.opacity = narrow ? '0.45' : still ? '0.5' : '0.62'
        layer.style.filter = 'saturate(0.7)'
      }
      return () => {
        for (const layer of layers) {
          layer.style.transform = ''
          layer.style.opacity = ''
          layer.style.filter = ''
        }
      }
    },
  )

  const still = () => reduced()
  const away = () => (phone() ? 'translateY(105%)' : 'translateX(14%) scale(0.96)')
  return (
    <div class="pointer-events-none absolute inset-0 z-20 overflow-hidden" ref={overlay}>
      <Show when={on() && !inFront() && !sideOpen()}>
        <ScopedConversation id={props.voice}>
          <Collapsed phone={phone()} />
        </ScopedConversation>
      </Show>
      <Show when={inFront() && phone()}>
        <Button
          aria-label="Show @ultimate, keep Voice listening"
          class="pointer-events-auto absolute inset-x-0 top-0 flex h-11 items-center justify-center gap-2 rounded-none bg-gradient-to-b from-background via-background/90 to-background/40 font-mono text-[11px] font-normal text-muted-foreground"
          onClick={() => live.setFront(false)}
          size={null}
          variant={null}
        >
          <span class="size-1.5 rounded-full bg-brand motion-safe:animate-pulse" />
          Voice keeps listening · <span class="text-foreground">show @ultimate</span>
        </Button>
      </Show>
      <Show when={inFront() || exiting()}>
        <section
          aria-label="Voice"
          class={cn(
            'absolute flex flex-col overflow-hidden border border-border bg-background shadow-2xl shadow-black/40',
            inFront() && 'pointer-events-auto',
            phone()
              ? 'inset-x-0 top-11 bottom-0 rounded-t-2xl border-b-0'
              : 'top-3 right-5 bottom-3 rounded-xl',
          )}
          data-voice-live-stage={props.voice}
          inert={!inFront()}
          style={{
            width: phone() ? undefined : `min(40rem, ${Math.round(width() * 0.56)}px)`,
            transition: still()
              ? `opacity ${duration}ms ease`
              : `transform ${duration}ms ${ease}, opacity ${duration}ms ease`,
            transform: inFront() || still() ? 'none' : away(),
            opacity: inFront() ? 1 : 0,
          }}
        >
          <ScopedConversation id={props.voice}>
            <header class="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
              <AudioLinesIcon class="size-3.5 text-brand" />
              <span class="text-[13px] font-semibold">Voice</span>
              <span class="truncate font-mono text-[11px] text-muted-foreground">
                relay to @ultimate
              </span>
              <span class="ml-auto flex items-center gap-2">
                <span class="font-mono text-[10.5px] text-muted-foreground/70 pointer-coarse:hidden">
                  <Kbd>{keyHint}</Kbd> back
                </span>
                <Button
                  aria-label="Collapse Voice; it keeps listening"
                  class="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-normal text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
                  onClick={() => live.setFront(false)}
                  size={null}
                  title={`Collapse · keeps listening · ${keyHint}`}
                  variant={null}
                >
                  <Minimize2Icon class="size-3.5" />
                  Collapse
                </Button>
              </span>
            </header>
            <Conversation variant={phone() ? 'dock' : 'main'} />
          </ScopedConversation>
        </section>
      </Show>
    </div>
  )
}

function Collapsed(props: { phone: boolean }) {
  const step = useStep()
  return (
    <div
      class={cn(
        'pointer-events-auto absolute flex items-center gap-1 rounded-2xl border bg-background/95 p-1 shadow-xl shadow-black/30 backdrop-blur motion-safe:animate-fade-in',
        needsAttention(step()) ? 'border-brand/40' : 'border-border',
        props.phone ? 'inset-x-3 top-2' : 'top-3 right-5 w-80',
      )}
      data-voice-live-collapsed={step().step}
    >
      <Button
        aria-label={`Voice: ${step().step} · expand`}
        class="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl p-1 text-left font-normal outline-none hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => live.setFront(true)}
        size={null}
        title={`Expand Voice · ${keyHint}`}
        variant={null}
      >
        <StepMark size="small" step={step()} />
        <span class="min-w-0 flex-1">
          <StepLine step={step()} />
        </span>
        <Maximize2Icon class="mr-1 size-3.5 shrink-0 text-muted-foreground" />
      </Button>
      <Show
        when={mode().phase !== 'paused'}
        fallback={
          <Button
            aria-label="Resume listening from the collapsed voice card"
            class="h-8 shrink-0 rounded-lg px-2 text-[12px] font-normal text-brand outline-none hover:bg-brand/15 focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => void live.open(mode().waiting)}
            size={null}
            variant={null}
          >
            {mode().waiting ? 'Hear it' : 'Resume'}
          </Button>
        }
      >
        <MuteButton
          class="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          large
          location="collapsed voice card"
        />
      </Show>
      <Button
        aria-label="End voice relay from the collapsed card"
        class="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-error/15 hover:text-error focus-visible:ring-1 focus-visible:ring-ring"
        onClick={live.end}
        size={null}
        title="End voice relay"
        variant={null}
      >
        <PhoneOffIcon class="size-4" />
      </Button>
    </div>
  )
}

function StepLine(props: { step: Step }) {
  const summary: Partial<Record<Step['step'], string>> = {
    hearing: 'Hearing you…',
    speaking: 'Speaking',
    deciding: 'Thinking it over',
    working: '@ultimate is on it',
    answer: 'Answer ready',
    waiting: 'Answer ready',
    connecting: 'Connecting…',
    loading: 'Loading context…',
    paused: 'Listening paused',
    muted: 'Muted',
    ending: 'Ending…',
  }
  const detail = () => {
    const step = props.step
    return (
      (step.step === 'hearing' && mode().partial) ||
      (step.step === 'working' ? step.request : 'Voice · tap to expand')
    )
  }
  return (
    <>
      <span class="block truncate text-[13px] leading-tight font-semibold">
        {summary[props.step.step] ?? 'Listening'}
      </span>
      <span
        class="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground [direction:rtl]"
        title={detail()}
      >
        <bdi>{detail()}</bdi>
      </span>
    </>
  )
}

type Step =
  | {
      step:
        | 'off'
        | 'connecting'
        | 'loading'
        | 'ending'
        | 'paused'
        | 'waiting'
        | 'muted'
        | 'listening'
        | 'hearing'
        | 'speaking'
        | 'deciding'
        | 'answer'
    }
  | { step: 'working'; request: string; since?: number }

const needsAttention = (step: Step) => ['working', 'answer', 'waiting'].includes(step.step)

function useStep() {
  const conversation = useConversation()
  const transcript = useTranscript()
  const pending = createMemo(() => pendingVoice(transcript()))
  return createMemo((): Step => {
    const state = mode()
    if (state.phase === 'off') return { step: 'off' }
    if (state.phase === 'starting') return { step: 'connecting' }
    if (state.phase === 'ending') return { step: 'ending' }
    if (state.phase === 'paused') return { step: state.waiting ? 'waiting' : 'paused' }
    if (state.floor === 'user') return { step: 'hearing' }
    const { brief, unspoken, open } = pending()
    if (!brief) return { step: 'loading' }
    if (state.floor === 'voice') return { step: 'speaking' }
    if (unspoken) return { step: 'answer' }
    if (conversation().busy) return { step: 'deciding' }
    if (VoiceLineEntry.is(open))
      return { step: 'working', request: open.data.text, since: open.data.at }
    return { step: state.muted ? 'muted' : 'listening' }
  })
}

function pendingVoice(transcript: readonly EntryRecord[]) {
  const settled = new Map<number, { answered: boolean; spoken: boolean; failed: boolean }>()
  for (const entry of transcript) {
    if (!VoiceLineEntry.is(entry) && !VoiceAnswerEntry.is(entry)) continue
    const re = entry.data?.re
    if (re === undefined) continue
    const state = settled.get(re) ?? { answered: false, spoken: false, failed: false }
    if (entry.kind === 'voice.answer') state.answered = true
    const role = VoiceLineEntry.is(entry) && entry.data.role
    if (role === 'ultimate') state.spoken = true
    if (role === 'notice') state.failed = true
    settled.set(re, state)
  }
  const open = transcript.findLast(
    (entry) =>
      VoiceLineEntry.is(entry) &&
      entry.data.forwarded &&
      !settled.get(entry.id)?.answered &&
      !settled.get(entry.id)?.failed,
  )
  const unspoken = [...settled.values()].some((state) => state.answered && !state.spoken)
  const started = transcript.findLastIndex(
    (entry) => VoiceSessionEntry.is(entry) && entry.data.phase === 'started',
  )
  const brief =
    started < 0 || transcript.slice(started).some((entry) => entry.kind === 'voice.context')
  return { open, unspoken, brief }
}

const stepText = {
  off: ['Voice is off', 'Start it to talk to @ultimate'],
  connecting: ['Connecting…', 'Opening the microphone and the voice session'],
  loading: ['Loading context…', 'Voice reads what @ultimate is up to · talk any time'],
  ending: ['Ending…', 'Closing the session'],
  paused: ['Listening paused', 'Closed after two quiet minutes · an answer wakes it'],
  waiting: ['Answer ready', 'Tap Hear it to hear it'],
  hearing: ['Hearing you…', 'Keep talking · a pause sends it'],
  speaking: ['Speaking', 'Interrupt any time'],
  deciding: ['Thinking it over', 'Voice decides whether this goes to @ultimate'],
  answer: ['Answer ready', 'Putting it into words'],
  muted: ['Muted', '@ultimate keeps working · unmute to talk'],
  listening: ['Listening', 'Talk · requests go to @ultimate'],
}

function StepText(props: { step: Step }) {
  const { main } = useIds()
  const summary = useConversationSummary(main)
  const phase = useProvided(ConversationPhase, () => (summary()?.busy ? main() : undefined))
  const now = useNow(
    1000,
    createMemo(() => props.step.step === 'working' || livePhase()),
  )
  const session = () =>
    livePhase() && mode().billedSince !== undefined ? clock(now() - mode().billedSince!) : undefined
  const working = () => (props.step.step === 'working' ? props.step : undefined)
  const text = () => (props.step.step === 'working' ? undefined : stepText[props.step.step])
  return (
    <div class="min-w-0 flex-1" aria-live="polite" data-voice-step={props.step.step}>
      <div class="flex min-w-0 items-baseline gap-2 text-[17px] leading-tight font-semibold sm:text-[19px]">
        <span class="min-w-0 truncate">
          <Show when={working()} fallback={text()?.[0]}>
            {(step) => (
              <span class="flex min-w-0 items-baseline gap-2">
                <span class="shrink-0">@ultimate is on it</span>
                <Show when={step().since !== undefined}>
                  <span class="font-mono text-[13px] font-normal text-muted-foreground tabular-nums">
                    {clock(now() - step().since!)}
                  </span>
                </Show>
              </span>
            )}
          </Show>
        </span>
        <Show when={session() && !working()}>
          <span class="shrink-0 font-mono text-[11px] font-normal text-muted-foreground tabular-nums">
            {session()}
          </span>
        </Show>
      </div>
      <div class="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
        <Show when={working()} fallback={text()?.[1]}>
          {(step) => (
            <span class="flex min-w-0 items-center gap-1">
              <Show when={phase()}>
                {(value) => (
                  <span class="shrink-0 text-brand">
                    {value().word[0].toUpperCase() + value().word.slice(1)} ·
                  </span>
                )}
              </Show>
              <span class="truncate">{step().request}</span>
            </span>
          )}
        </Show>
      </div>
    </div>
  )
}

function StepMark(props: { step: Step; size?: 'small' | 'large' }) {
  const busy = () =>
    ['connecting', 'loading', 'ending', 'deciding', 'working', 'answer'].includes(props.step.step)
  const hot = () => livePhase() && !mode().muted
  return (
    <span
      class={cn(
        'flex shrink-0 items-center justify-center rounded-full transition-colors',
        props.size === 'small' ? 'size-9 [&_svg]:size-4' : 'size-11',
        busy() || props.step.step === 'speaking'
          ? 'bg-brand/12 text-brand'
          : hot()
            ? 'bg-error/12 text-error'
            : 'bg-muted text-muted-foreground',
      )}
    >
      {busy() ? (
        <LoaderCircleIcon class="size-5 motion-safe:animate-spin motion-safe:[animation-duration:1.6s]" />
      ) : props.step.step === 'speaking' ? (
        <Volume2Icon class="size-5" />
      ) : mode().muted && livePhase() ? (
        <MicOffIcon class="size-5" />
      ) : hot() ? (
        <Level bar="bg-error" class="h-5" />
      ) : (
        <MicIcon class="size-5" />
      )}
    </span>
  )
}

function VoiceDock(props: SolidComposerProps) {
  const id = useConversationId()
  const { voice } = useIds()
  return (
    <Show when={id() !== undefined && id() === voice()} fallback={props.core}>
      <VoiceControls />
    </Show>
  )
}

function VoiceControls() {
  const step = useStep()
  const off = () => mode().phase === 'off'
  return (
    <div class={cn(column(), 'pt-1 pb-3')} data-voice-live-dock>
      <Show when={mode().problem}>
        <p
          class="mb-2 flex items-start gap-1.5 rounded-md border border-error/30 bg-error/5 px-2.5 py-1.5 font-mono text-[11px] break-words text-error"
          role="alert"
        >
          <CircleAlertIcon class="mt-px size-3.5 shrink-0" />
          <span class="min-w-0 flex-1">{mode().problem}</span>
          <Button
            aria-label="Dismiss voice controls error"
            class="shrink-0 rounded-sm hover:text-foreground"
            onClick={live.clearProblem}
            size={null}
            variant={null}
          >
            <XIcon class="size-3.5" />
          </Button>
        </p>
      </Show>
      <div
        class={cn(
          'flex flex-wrap items-center gap-x-3 gap-y-2.5 rounded-xl border px-3 py-3 transition-colors',
          needsAttention(step()) ? 'border-brand/35 bg-brand/5' : 'border-border bg-muted/20',
        )}
      >
        <div class="flex min-w-0 flex-[1_1_16rem] items-center gap-3">
          <StepMark step={step()} />
          <StepText step={step()} />
        </div>
        <div class="ml-auto flex shrink-0 items-center gap-2">
          <Show
            when={off() || mode().phase === 'paused'}
            fallback={
              <MuteButton
                class="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] font-normal hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
                large
                location="voice controls"
                text
              />
            }
          >
            <Button
              aria-label={
                off() ? 'Start listening in voice controls' : 'Resume listening in voice controls'
              }
              class="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-brand/50 px-3 text-[13px] font-normal hover:border-brand focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
              onClick={() => void (off() ? live.start() : live.open(mode().waiting))}
              size={null}
              variant={null}
            >
              <AudioLinesIcon class="size-4 text-brand" />
              {off() ? 'Start' : mode().waiting ? 'Hear it' : 'Resume'}
            </Button>
          </Show>
          <Show when={!off()}>
            <Button
              aria-label="End voice relay from voice controls"
              class="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-error px-3 text-[13px] font-normal text-white hover:bg-error/90 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
              onClick={live.end}
              size={null}
              variant={null}
            >
              <PhoneOffIcon class="size-4" />
              <span class="max-sm:hidden">End</span>
            </Button>
          </Show>
        </div>
      </div>
    </div>
  )
}

function VoiceRow(props: { conversation: ConversationId | undefined }) {
  const { voice } = useIds()
  const shown = useConversationId()
  const on = () => mode().phase !== 'off'
  const inFront = () => on() && mode().front && shown() === props.conversation
  const current = () => inFront() || shown() === voice()
  const hot = () => livePhase() && !mode().muted
  const word = () =>
    !on()
      ? 'off'
      : livePhase()
        ? mode().muted
          ? 'muted'
          : 'live'
        : mode().phase === 'paused'
          ? mode().waiting
            ? 'answer waiting'
            : 'paused'
          : mode().phase === 'starting'
            ? 'connecting'
            : 'ending'
  return (
    <Show when={props.conversation !== undefined && voice()}>
      {(id) => (
        <Button
          aria-current={current() ? 'true' : undefined}
          aria-label={
            on() ? (inFront() ? 'Park Voice sheet' : 'Open Voice sheet') : 'Open Voice conversation'
          }
          class={cn(
            'mx-2 flex w-[calc(100%-1rem)] items-center justify-start gap-1.5 rounded-md py-1.5 pr-2 pl-9 text-left font-normal outline-none hover:bg-sidebar-accent/50 focus-visible:ring-1 focus-visible:ring-ring',
            current() && 'bg-sidebar-accent',
          )}
          data-voice-live-row={id()}
          onClick={() => {
            if (!on()) return switchConversation(id())
            toggleFront()
          }}
          size={null}
          title={
            on()
              ? `${mode().front ? 'Send Voice back' : 'Bring Voice to the front'} · ${keyHint}`
              : 'Open Voice'
          }
          variant={null}
        >
          <AudioLinesIcon
            class={cn('size-3 shrink-0', on() ? 'text-brand' : 'text-muted-foreground')}
          />
          <span class="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground/80">
            Voice
          </span>
          <span
            class={cn(
              'flex shrink-0 items-center gap-1 font-mono text-[10px]',
              hot() ? 'text-error' : mode().waiting ? 'text-brand' : 'text-muted-foreground',
            )}
          >
            <Show when={hot()}>
              <span class="size-1.5 rounded-full bg-error motion-safe:animate-pulse" />
            </Show>
            {word()}
          </span>
        </Button>
      )}
    </Show>
  )
}

function voiceIds() {
  const { voice } = useIds()
  return createMemo(() => {
    const id = voice()
    return new Set(id === undefined ? [] : [id])
  })
}

export default defineWebExtension({
  slots: {
    'composer.actions': [StartButton],
    'titlebar.right': [LiveIndicator],
    'conversation.overlay': [Stage],
    'transcript.end': [LiveTurn],
    overlay: [Relay],
  },
  composer: VoiceDock,
  provides: [provide(UnderUltimate, VoiceRow), provide(Unlisted, voiceIds)],
  tools: {
    voice_say: () => null,
    voice_ask_ultimate: () => null,
    voice_note: () => null,
    voice_show: () => null,
    voice_question: () => null,
    voice_answer: () => null,
  },
  entries: {
    'voice.line': LineRow,
    'voice.heard': HeardRow,
    'voice.answer': () => null,
    'pi.assistant': QuietAgentRow,
    'voice.session': SessionRow,
    'voice.context': ContextRow,
    'voice.utterance': UtteranceRow,
    'voice.question': QuestionRow,
  },
  commands: [
    {
      id: 'voice-live.start',
      title: 'Start voice relay',
      when: () => live.voiceMode().phase === 'off',
      run: () => live.start(),
    },
    {
      id: 'voice-live.front',
      title: 'Voice relay: bring to front or send back',
      keys: KEYS,
      when: () => live.voiceMode().phase !== 'off',
      run: toggleFront,
    },
    {
      id: 'voice-live.mute',
      title: 'Voice relay: mute or unmute',
      when: () => live.voiceMode().phase === 'live',
      run: () => live.setMuted(!live.voiceMode().muted),
    },
    {
      id: 'voice-live.end',
      title: 'End voice relay',
      when: () => live.voiceMode().phase !== 'off',
      run: () => live.end(),
    },
  ],
})
