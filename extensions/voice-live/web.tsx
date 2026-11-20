import type { EntryRecord, ConversationId } from '@earendil-works/pi-durable'
import { ROOT } from '@/sdk'
import { deadline } from '../../lib/timers.ts'
import {
  ArrowRightIcon,
  AudioLinesIcon,
  CheckIcon,
  BookOpenIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  MicIcon,
  MicOffIcon,
  Maximize2Icon,
  Minimize2Icon,
  PhoneOffIcon,
  SquareArrowOutUpRightIcon,
  Volume2Icon,
  XIcon,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Message, MessageContent, MessageResponse } from '@/components/ai/message'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  api,
  cn,
  column,
  Conversation,
  ConversationScope,
  defineWebExtension,
  events,
  formatKeys,
  formatTime,
  provide,
  Provided,
  useAction,
  useCommands,
  useConversation,
  useConversationSummary,
  useDocOf,
  useEvent,
  useNow,
  useTranscript,
  useUltimate,
  useViewport,
  UserText,
  UserView,
} from '@/sdk'
import type { EntryRenderer, UltimateActions } from '@/sdk'
import { ConversationPhase } from '../conversations/ui.tsx'
import { Body, Bubble } from '../messages/ui.tsx'
import { SideChatsDoc, useSideChatFront } from '../side-chat/ui.tsx'
import { UnderUltimate, Unlisted } from '../sidebar/ui.tsx'
import { openAgentSource, StandingDoc, talkToUltimate } from '../subagents/ui.tsx'
import * as live from './live.tsx'
import type { VoiceMode } from './live.tsx'
import { openQuestion } from '../../lib/message-state.ts'
import { MessagesDoc } from '../messages/ui.tsx'
import { AskedAction, LogAction, StatusAction } from './refs.ts'
import {
  VoiceLineEntry,
  VoiceSessionEntry,
  VoiceContextEntry,
  VoiceQuestionEntry,
  VoiceUtteranceEntry,
  VoiceAnswerEntry,
  VoiceHeardEntry,
} from './entries.ts'
import type { VoiceAnswer, VoiceGo, VoiceLine } from './refs.ts'

const KEYS = 'alt+v'
const useMode = () => useSyncExternalStore(live.subscribe, live.voiceMode)

function useIds() {
  const main = useDocOf(ROOT, StandingDoc)?.ultimate
  const voice = useDocOf(ROOT, StandingDoc)?.voice
  return { main, voice }
}

const start = live.start
const keepEditorFocus = (event: React.PointerEvent) => event.preventDefault()

function toggleFront(actions: Pick<UltimateActions, 'switchConversation' | 'showSurface'>) {
  const front = !live.voiceMode().front
  live.setFront(front)
  if (front) void talkToUltimate(actions)
}

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

const keyHint = formatKeys(KEYS)[0].join(formatKeys(KEYS)[0][0] === 'Alt' ? '+' : '')

function Level({ className, bar }: { className?: string; bar: string }) {
  const bars = useRef<HTMLSpanElement[]>([])
  const { phase, muted } = useMode()
  useEffect(() => {
    const analyser = phase === 'live' && !muted ? live.analyser() : undefined
    if (!analyser) {
      for (const element of bars.current) element.style.transform = ''
      return undefined
    }
    const samples = new Uint8Array(analyser.fftSize)
    let frame = requestAnimationFrame(function draw() {
      analyser.getByteTimeDomainData(samples)
      let sum = 0
      for (const sample of samples) sum += ((sample - 128) / 128) ** 2
      const level = Math.min(1, Math.sqrt(sum / samples.length) * 4)
      bars.current.forEach((element, index) => {
        const shape = [0.55, 1, 0.8, 0.45][index] ?? 1
        element.style.transform = `scaleY(${0.2 + 0.8 * level * shape})`
      })
      frame = requestAnimationFrame(draw)
    })
    return () => cancelAnimationFrame(frame)
  }, [phase, muted])
  return (
    <span aria-hidden className={cn('flex items-center gap-[2px] motion-reduce:hidden', className)}>
      {[0, 1, 2, 3].map((index) => (
        <span
          className={cn('h-full w-[2px] origin-center scale-y-[0.2] rounded-full', bar)}
          key={index}
          ref={(element) => {
            if (element) bars.current[index] = element
          }}
        />
      ))}
    </span>
  )
}

function stateLabel(mode: VoiceMode) {
  if (mode.phase === 'starting') return 'Connecting…'
  if (mode.phase === 'ending') return 'Ending…'
  if (mode.waiting) return 'Answer waiting'
  if (mode.phase === 'paused') return 'Listening paused'
  return mode.muted ? 'Muted' : 'Live'
}

function StartButton() {
  const id = useConversation((conversation) => conversation.id)
  const { main } = useIds()
  const mode = useMode()
  const actions = useUltimate()
  const status = useAction(StatusAction)
  useEvent('secrets:changed', () => void status.refetch())
  useEffect(() => {
    if (status.data) live.rememberStatus(status.data)
  }, [status.data])
  if (id === undefined || id !== main) return null
  const missing = status.data?.available === false
  const on = mode.phase !== 'off'
  const label = missing
    ? 'Voice relay needs an OpenAI API key: tap to add it'
    : on
      ? mode.front
        ? 'Voice relay is on · send Voice back'
        : 'Voice relay is on · bring Voice to the front'
      : 'Start voice relay: talk to @ultimate, hear its answers'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-disabled={missing || status.loading}
          aria-label={label}
          aria-pressed={on}
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground pointer-coarse:size-9',
            on && 'bg-brand/15 text-brand hover:bg-brand/20 hover:text-brand',
            missing && 'opacity-50 hover:bg-transparent hover:text-muted-foreground',
          )}
          data-voice-live={missing ? 'unavailable' : on ? mode.phase : 'off'}
          onClick={() => {
            if (status.loading) return
            if (missing) return events.emit('secrets:open', { name: 'OPENAI_API_KEY' })
            if (on) return toggleFront(actions)
            void start()
          }}

          onPointerDown={keepEditorFocus}
          type="button"
        >
          {mode.phase === 'starting' ? (
            <LoaderCircleIcon className="size-4 motion-safe:animate-spin" />
          ) : (
            <AudioLinesIcon className="size-4" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

const pillButton =
  'flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring max-md:size-7'

function LiveIndicator() {
  const mode = useMode()
  const actions = useUltimate()
  const phone = useViewport() === 'phone'
  const now = useNow(1000, mode.phase === 'live')
  const { main } = useIds()
  if (mode.phase === 'off' && !mode.problem) return null

  const voiceCardVisible =
    mode.phase !== 'off' && actions.surface === 'agent' && actions.conversationId === main
  if (voiceCardVisible) return null
  if (mode.phase === 'off')
    return (
      <span
        className="flex h-6 max-w-80 items-center gap-1.5 rounded-full border border-error/40 bg-error/10 pr-0.5 pl-2.5 text-error"
        data-voice-live-indicator="failed"
        role="alert"
      >
        <span className="truncate" title={mode.problem}>
          {mode.problem}
        </span>
        <button
          aria-label="Dismiss"
          className={cn(pillButton, 'text-error hover:text-error')}
          onClick={live.clearProblem}
          type="button"
        >
          <XIcon className="size-3" />
        </button>
      </span>
    )
  const asleep = mode.phase === 'paused'
  const hot = mode.phase === 'live' && !mode.muted
  const label = stateLabel(mode)
  return (
    <span
      aria-label="Voice relay"
      className={cn(
        'flex h-6 items-center gap-0.5 rounded-full border pr-0.5 pl-1 text-foreground max-md:h-8',
        hot ? 'border-error/40 bg-error/10' : 'border-border bg-muted/40',
        mode.waiting && 'border-brand/60 bg-brand/10',
      )}
      data-voice-live-indicator={mode.phase}
      role="group"
    >
      <button
        aria-label={`${label} · ${mode.front ? 'send Voice back' : 'bring Voice to the front'}`}
        className="flex h-full min-w-0 cursor-pointer items-center gap-1.5 rounded-full px-1.5 outline-none hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => toggleFront(actions)}
        title={`${mode.front ? 'Send Voice back' : 'Bring Voice to the front'} · ${keyHint}`}
        type="button"
      >
        {mode.phase === 'starting' || mode.phase === 'ending' ? (
          <LoaderCircleIcon className="size-3 shrink-0 text-muted-foreground motion-safe:animate-spin" />
        ) : (
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              hot ? 'bg-error motion-safe:animate-pulse' : 'bg-muted-foreground/60',
              mode.waiting && 'bg-brand motion-safe:animate-pulse',
            )}
          />
        )}
        <span
          className={cn(
            'truncate',
            hot ? 'text-error' : 'text-muted-foreground',
            mode.waiting && 'text-brand',
          )}
        >
          {phone && asleep && !mode.waiting ? 'Paused' : label}
        </span>
        {mode.phase === 'live' && mode.billedSince !== undefined && (
          <span className="text-muted-foreground tabular-nums">
            {clock(now - mode.billedSince)}
          </span>
        )}
        {mode.phase === 'live' && <Level bar="bg-error" className="h-3" />}
      </button>
      {mode.problem && (
        <span
          className="max-w-48 truncate px-1 text-error max-lg:hidden"
          role="alert"
          title={mode.problem}
        >
          {mode.problem}
        </span>
      )}
      {asleep ? (
        <button
          className="h-full shrink-0 cursor-pointer rounded-full px-2 text-brand outline-none hover:bg-brand/15 focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => void live.open(mode.waiting)}
          title="Resume listening: starts a new session"
          type="button"
        >
          {mode.waiting ? 'Tap to hear' : 'Resume'}
        </button>
      ) : (
        <button
          aria-label={mode.muted ? 'Unmute microphone' : 'Mute microphone'}
          aria-pressed={mode.muted}
          className={cn(pillButton, mode.muted && 'text-warning hover:text-warning')}
          disabled={mode.phase !== 'live'}
          onClick={() => live.setMuted(!mode.muted)}
          title={mode.muted ? 'Unmute' : 'Mute'}
          type="button"
        >
          {mode.muted ? <MicOffIcon className="size-3.5" /> : <MicIcon className="size-3.5" />}
        </button>
      )}
      <button
        aria-label="End voice relay"
        className={cn(pillButton, 'hover:bg-error/15 hover:text-error')}
        onClick={live.end}
        title="End voice relay: closes the session"
        type="button"
      >
        <PhoneOffIcon className="size-3.5" />
      </button>
    </span>
  )
}

function Relay() {
  const { phase } = useMode()
  const { voice } = useIds()
  if (phase === 'off' || voice === undefined) return null
  return (
    <ConversationScope id={voice}>
      <SpeakNew voice={voice} />
      <Announce />
    </ConversationScope>
  )
}

const questionAnnouncementQuietMs = 2000

function Announce() {
  const log = useDocOf(ROOT, MessagesDoc)
  const mode = useMode()
  const seenThisSession = useRef<Set<number>>(undefined)
  const [due, setDue] = useState<number[]>([])
  const [quietSince, setQuietSince] = useState(Date.now())
  const busy = mode.floor !== undefined || mode.speaking !== undefined || mode.phase !== 'live'

  useEffect(() => {
    if (!busy) setQuietSince(Date.now())
  }, [busy])
  useEffect(() => {
    if (!log) return
    const open = log.messages.filter(openQuestion).map((m) => m.id)
    if (seenThisSession.current === undefined) {
      seenThisSession.current = new Set(open)
      return
    }
    const fresh = open.filter((id) => !seenThisSession.current!.has(id))
    for (const id of fresh) seenThisSession.current.add(id)
    if (fresh.length) setDue((current) => [...current, ...fresh])
  }, [log])
  useEffect(() => {
    if (!due.length || busy) return undefined
    return deadline(Math.max(0, quietSince + questionAnnouncementQuietMs - Date.now()), () => {
      setDue([])
      for (const message of due)
        api
          .action(AskedAction, { message })
          .catch((error: unknown) => console.warn('Voice announce failed', error))
    })
  }, [due, busy, quietSince])
  return null
}

function navigate(go: VoiceGo, actions: UltimateActions, commands: ReturnType<typeof useCommands>) {
  live.setFront(false)
  if (go.message !== undefined) return events.emit('inbox:open', { message: go.message })
  if (go.conversation !== undefined) {
    actions.showSurface('agent')
    return actions.switchConversation(go.conversation)
  }
  const wanted = go.surface!.trim().toLowerCase()
  const surface = commands.find(
    (command) =>
      command.id === `ultimate.surface.${wanted}` ||
      command.title.toLowerCase() === `switch to ${wanted}`,
  )
  if (surface) return actions.showSurface(surface.id.slice('ultimate.surface.'.length))
  api
    .action(LogAction, { role: 'notice', text: `No "${go.surface}" to show here` })
    .catch((error: unknown) => console.warn('Voice notice failed', error))
}

function SpeakNew({ voice }: { voice: number }) {
  const entries = useConversation((conversation) => conversation.entries)
  const loading = useConversation((conversation) => conversation.loading)
  const actions = useUltimate()
  const commands = useCommands()
  const navigation = useRef({ actions, commands })
  navigation.current = { actions, commands }
  const seenThisSession = useRef<number>(undefined)
  useEffect(() => {
    if (loading) return
    const last = entries.at(-1)?.id ?? 0
    const lines = entries.filter((candidate) => VoiceLineEntry.is(candidate))
    live.working(
      lines.some((entry) => {
        const line = entry.data
        return line.forwarded && !lines.some((reply) => reply.data.re === entry.id)
      }),
    )
    if (seenThisSession.current === undefined) {
      seenThisSession.current = last
      return
    }
    for (const entry of entries) {
      if (entry.id <= seenThisSession.current || !VoiceLineEntry.is(entry)) continue
      const line = entry.data
      if (line.role === 'ultimate' && line.speech) live.hear(line.text, entry.id)
      else if (line.role === 'note') live.note(line.text)
      else if (line.role === 'action' && line.go)
        navigate(line.go, navigation.current.actions, navigation.current.commands)
    }
    seenThisSession.current = Math.max(seenThisSession.current, last)
  }, [entries, loading])

  useEffect(() => () => (seenThisSession.current = undefined), [voice])
  return null
}

const ease = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
const duration = 420
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

function Stage() {
  const id = useConversation((conversation) => conversation.id)
  const { main, voice } = useIds()
  const mode = useMode()
  const [sideFront, setSideFront] = useSideChatFront()
  const sides = useDocOf(main, SideChatsDoc)?.sides
  const sideOpen = sides?.some((side) => side.id === sideFront && side.ended === undefined)
  const phone = useViewport() === 'phone'
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const isMain = id !== undefined && id === main
  const inFront = isMain && voice !== undefined && mode.phase !== 'off' && mode.front && !sideOpen

  const was = useRef({ front: mode.front, side: sideOpen })
  useEffect(() => {
    const voiceDisplacesSideChat = mode.front && !was.current.front && sideOpen
    if (voiceDisplacesSideChat) setSideFront(null)
    else if (sideOpen && !was.current.side && mode.front) live.setFront(false)
    was.current = { front: mode.front, side: sideOpen }
  }, [mode.front, sideOpen, setSideFront])

  const [shown, setShown] = useState(false)
  if (inFront && !shown) setShown(true)
  useEffect(() => {
    if (inFront) return undefined
    return deadline(duration + 60, () => setShown(false))
  }, [inFront])

  useLayoutEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent) return undefined
    const observer = new ResizeObserver(() => setWidth(parent.clientWidth))
    observer.observe(parent)
    return () => observer.disconnect()
  }, [isMain, voice])

  useLayoutEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent || !inFront) return undefined
    const layers = [...parent.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement && !child.contains(ref.current),
    )
    const still = reduced()

    const reading = layers
      .map((layer) => layer.querySelector<HTMLElement>('[data-ui="transcript"]'))
      .find(Boolean)
    const readingColumnWidth = reading?.offsetWidth ?? width
    const scale = phone ? 0.92 : 0.88
    const shift = phone ? 0 : Math.min(0, 24 - (width / 2 - (readingColumnWidth / 2) * scale))
    for (const layer of layers) {
      layer.style.transition = still
        ? `opacity ${duration}ms ease`
        : `transform ${duration}ms ${ease}, opacity ${duration}ms ease, filter ${duration}ms ease`
      layer.style.transformOrigin = `50% ${(phone ? 0 : parent.clientHeight / 2) - layer.offsetTop}px`
      layer.style.transform = still
        ? ''
        : phone
          ? `translateY(10px) scale(${scale})`
          : `translateX(${shift}px) scale(${scale})`
      layer.style.opacity = phone ? '0.45' : still ? '0.5' : '0.62'
      layer.style.filter = 'saturate(0.7)'
    }
    return () => {
      for (const layer of layers) {
        layer.style.transform = ''
        layer.style.opacity = ''
        layer.style.filter = ''
      }
    }
  }, [inFront, width, phone])

  if (!isMain || voice === undefined) return null
  const collapsed = mode.phase !== 'off' && !inFront && !sideOpen
  const still = reduced()
  const away = phone ? 'translateY(105%)' : 'translateX(14%) scale(0.96)'
  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden" ref={ref}>
      {collapsed && (
        <ConversationScope id={voice}>
          <Collapsed phone={phone} />
        </ConversationScope>
      )}
      {inFront && phone && (
        <button
          className="pointer-events-auto absolute inset-x-0 top-0 flex h-11 cursor-pointer items-center justify-center gap-2 bg-gradient-to-b from-background via-background/90 to-background/40 font-mono text-[11px] text-muted-foreground"
          onClick={() => live.setFront(false)}
          type="button"
        >
          <span className="size-1.5 rounded-full bg-brand motion-safe:animate-pulse" />
          Voice keeps listening · <span className="text-foreground">show @ultimate</span>
        </button>
      )}
      {shown && (
        <section
          aria-label="Voice"
          className={cn(
            'absolute flex flex-col overflow-hidden border border-border bg-background shadow-2xl shadow-black/40',
            inFront && 'pointer-events-auto',
            phone
              ? 'inset-x-0 top-11 bottom-0 rounded-t-2xl border-b-0'
              : 'top-3 right-5 bottom-3 rounded-xl',
          )}
          data-voice-live-stage={voice}
          inert={!inFront}
          style={{
            width: phone ? undefined : `min(40rem, ${Math.round(width * 0.56)}px)`,
            transition: still
              ? `opacity ${duration}ms ease`
              : `transform ${duration}ms ${ease}, opacity ${duration}ms ease`,
            transform: inFront || still ? 'none' : away,
            opacity: inFront ? 1 : 0,
          }}
        >
          <ConversationScope id={voice}>
            <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
              <AudioLinesIcon className="size-3.5 text-brand" />
              <span className="text-[13px] font-semibold">Voice</span>
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                relay to @ultimate
              </span>
              <span className="ml-auto flex items-center gap-2">
                <span className="font-mono text-[10.5px] text-muted-foreground/70 pointer-coarse:hidden">
                  <Kbd>{keyHint}</Kbd> back
                </span>
                <button
                  aria-label="Collapse Voice; it keeps listening"
                  className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
                  onClick={() => live.setFront(false)}
                  title={`Collapse · keeps listening · ${keyHint}`}
                  type="button"
                >
                  <Minimize2Icon className="size-3.5" />
                  Collapse
                </button>
              </span>
            </header>
            <Conversation variant={phone ? 'dock' : 'main'} />
          </ConversationScope>
        </section>
      )}
    </div>
  )
}

function Collapsed({ phone }: { phone: boolean }) {
  const mode = useMode()
  const step = useStep(mode)
  const asleep = mode.phase === 'paused'
  return (
    <div
      className={cn(
        'pointer-events-auto absolute flex items-center gap-1 rounded-2xl border bg-background/95 p-1 shadow-xl shadow-black/30 backdrop-blur motion-safe:animate-fade-in',
        step.step === 'working' || step.step === 'answer' || step.step === 'waiting'
          ? 'border-brand/40'
          : 'border-border',
        phone ? 'inset-x-3 top-2' : 'top-3 right-5 w-80',
      )}
      data-voice-live-collapsed={step.step}
    >
      <button
        aria-label={`Voice: ${step.step} · expand`}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-xl p-1 text-left outline-none hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => live.setFront(true)}
        title={`Expand Voice · ${keyHint}`}
        type="button"
      >
        <StepMark mode={mode} size="small" step={step} />
        <span className="min-w-0 flex-1">
          <StepLine mode={mode} step={step} />
        </span>
        <Maximize2Icon className="mr-1 size-3.5 shrink-0 text-muted-foreground" />
      </button>
      {asleep ? (
        <button
          className="h-8 shrink-0 cursor-pointer rounded-lg px-2 text-[12px] text-brand outline-none hover:bg-brand/15 focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => void live.open(mode.waiting)}
          type="button"
        >
          {mode.waiting ? 'Hear it' : 'Resume'}
        </button>
      ) : (
        <button
          aria-label={mode.muted ? 'Unmute microphone' : 'Mute microphone'}
          aria-pressed={mode.muted}
          className={cn(
            'flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
            mode.muted && 'text-warning hover:text-warning',
          )}
          disabled={mode.phase !== 'live'}
          onClick={() => live.setMuted(!mode.muted)}
          title={mode.muted ? 'Unmute' : 'Mute'}
          type="button"
        >
          {mode.muted ? <MicOffIcon className="size-4" /> : <MicIcon className="size-4" />}
        </button>
      )}
      <button
        aria-label="End voice relay"
        className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-error/15 hover:text-error focus-visible:ring-1 focus-visible:ring-ring"
        onClick={live.end}
        title="End voice relay"
        type="button"
      >
        <PhoneOffIcon className="size-4" />
      </button>
    </div>
  )
}

function StepLine({ step, mode }: { step: Step; mode: VoiceMode }) {
  const newestWordsClass =
    'mt-0.5 block truncate font-mono text-[11px] text-muted-foreground [direction:rtl]'
  const title =
    step.step === 'hearing'
      ? 'Hearing you…'
      : step.step === 'speaking'
        ? 'Speaking'
        : step.step === 'deciding'
          ? 'Thinking it over'
          : step.step === 'working'
            ? '@ultimate is on it'
            : step.step === 'answer' || step.step === 'waiting'
              ? 'Answer ready'
              : step.step === 'connecting'
                ? 'Connecting…'
                : step.step === 'loading'
                  ? 'Loading context…'
                  : step.step === 'paused'
                    ? 'Listening paused'
                    : step.step === 'muted'
                      ? 'Muted'
                      : step.step === 'ending'
                        ? 'Ending…'
                        : 'Listening'
  const detail =
    step.step === 'hearing' && mode.partial
      ? mode.partial
      : step.step === 'working'
        ? step.request
        : 'Voice · tap to expand'
  return (
    <>
      <span className="block truncate text-[13px] leading-tight font-semibold">{title}</span>

      <span className={newestWordsClass} title={detail}>
        <bdi>{detail}</bdi>
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
    }
  | { step: 'hearing' | 'speaking' | 'deciding' | 'answer' }
  | { step: 'working'; request: string; since?: number }

function useStep(mode: VoiceMode): Step {
  const deciding = useConversation((conversation) => conversation.busy)
  const transcript = useTranscript()
  if (mode.phase === 'off') return { step: 'off' }
  if (mode.phase === 'starting') return { step: 'connecting' }
  if (mode.phase === 'ending') return { step: 'ending' }
  const settled = new Map<number, { answered: boolean; spoken: boolean; failed: boolean }>()
  for (const entry of transcript) {
    if (!VoiceLineEntry.is(entry) && !VoiceAnswerEntry.is(entry)) continue
    const data: { re?: number } | undefined = entry.data
    const re = data?.re
    if (re === undefined) continue
    const state = settled.get(re) ?? {
      answered: false,
      spoken: false,
      failed: false,
    }
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
  const sessionBriefArrived =
    started < 0 || transcript.slice(started).some((entry) => entry.kind === 'voice.context')
  if (mode.phase === 'paused') return { step: mode.waiting ? 'waiting' : 'paused' }
  if (mode.floor === 'user') return { step: 'hearing' }
  if (!sessionBriefArrived) return { step: 'loading' }
  if (mode.floor === 'voice') return { step: 'speaking' }
  if (unspoken) return { step: 'answer' }
  if (deciding) return { step: 'deciding' }
  if (VoiceLineEntry.is(open)) {
    const line = open.data
    return { step: 'working', request: line.text, since: line.at }
  }
  return { step: mode.muted ? 'muted' : 'listening' }
}

function StepText({ step, mode }: { step: Step; mode: VoiceMode }) {
  const { main } = useIds()
  const busy = useConversationSummary(main)?.busy
  const now = useNow(1000, step.step === 'working' || mode.phase === 'live')
  const session =
    mode.phase === 'live' && mode.billedSince !== undefined
      ? clock(now - mode.billedSince)
      : undefined
  const [title, detail]: [ReactNode, ReactNode] =
    step.step === 'off'
      ? ['Voice is off', 'Start it to talk to @ultimate']
      : step.step === 'connecting'
        ? ['Connecting…', 'Opening the microphone and the voice session']
        : step.step === 'loading'
          ? ['Loading context…', 'Voice reads what @ultimate is up to · talk any time']
          : step.step === 'ending'
            ? ['Ending…', 'Closing the session']
            : step.step === 'paused'
              ? ['Listening paused', 'Closed after two quiet minutes · an answer wakes it']
              : step.step === 'waiting'
                ? ['Answer ready', 'Tap Hear it to hear it']
                : step.step === 'hearing'
                  ? ['Hearing you…', 'Keep talking · a pause sends it']
                  : step.step === 'speaking'
                    ? ['Speaking', 'Interrupt any time']
                    : step.step === 'deciding'
                      ? ['Thinking it over', 'Voice decides whether this goes to @ultimate']
                      : step.step === 'answer'
                        ? ['Answer ready', 'Putting it into words']
                        : step.step === 'working'
                          ? [
                              <span className="flex min-w-0 items-baseline gap-2" key="working">
                                <span className="shrink-0">@ultimate is on it</span>
                                {step.since !== undefined && (
                                  <span className="font-mono text-[13px] font-normal text-muted-foreground tabular-nums">
                                    {clock(now - step.since)}
                                  </span>
                                )}
                              </span>,
                              <span className="flex min-w-0 items-center gap-1" key="request">
                                <Provided input={busy ? main : undefined} point={ConversationPhase}>
                                  {(phase) =>
                                    phase && (
                                      <span className="shrink-0 text-brand">
                                        {phase.word[0].toUpperCase() + phase.word.slice(1)} ·
                                      </span>
                                    )
                                  }
                                </Provided>
                                <span className="truncate">{step.request}</span>
                              </span>,
                            ]
                          : step.step === 'muted'
                            ? ['Muted', '@ultimate keeps working · unmute to talk']
                            : ['Listening', 'Talk · requests go to @ultimate']
  return (
    <div className="min-w-0 flex-1" aria-live="polite" data-voice-step={step.step}>
      <div className="flex min-w-0 items-baseline gap-2 text-[17px] leading-tight font-semibold sm:text-[19px]">
        <span className="min-w-0 truncate">{title}</span>
        {session && step.step !== 'working' && (
          <span className="shrink-0 font-mono text-[11px] font-normal text-muted-foreground tabular-nums">
            {session}
          </span>
        )}
      </div>
      <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{detail}</div>
    </div>
  )
}

function StepMark({
  step,
  mode,
  size = 'large',
}: {
  step: Step
  mode: VoiceMode
  size?: 'small' | 'large'
}) {
  const busy = ['connecting', 'loading', 'ending', 'deciding', 'working', 'answer'].includes(
    step.step,
  )
  const hot = mode.phase === 'live' && !mode.muted
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full transition-colors',
        size === 'small' ? 'size-9 [&_svg]:size-4' : 'size-11',
        busy
          ? 'bg-brand/12 text-brand'
          : step.step === 'speaking'
            ? 'bg-brand/12 text-brand'
            : hot
              ? 'bg-error/12 text-error'
              : 'bg-muted text-muted-foreground',
      )}
    >
      {busy ? (
        <LoaderCircleIcon className="size-5 motion-safe:animate-spin motion-safe:[animation-duration:1.6s]" />
      ) : step.step === 'speaking' ? (
        <Volume2Icon className="size-5" />
      ) : mode.muted && mode.phase === 'live' ? (
        <MicOffIcon className="size-5" />
      ) : hot ? (
        <Level bar="bg-error" className="h-5" />
      ) : (
        <MicIcon className="size-5" />
      )}
    </span>
  )
}

function VoiceDock({ core }: { core: ReactNode }) {
  const id = useConversation((conversation) => conversation.id)
  const { voice } = useIds()
  const mode = useMode()
  const step = useStep(mode)
  if (id === undefined || id !== voice) return core
  const off = mode.phase === 'off'
  const asleep = mode.phase === 'paused'
  return (
    <div className={cn(column(), 'pt-1 pb-3')} data-voice-live-dock>
      {mode.problem && (
        <p
          className="mb-2 flex items-start gap-1.5 rounded-md border border-error/30 bg-error/5 px-2.5 py-1.5 font-mono text-[11px] break-words text-error"
          role="alert"
        >
          <CircleAlertIcon className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{mode.problem}</span>
          <button
            aria-label="Dismiss"
            className="shrink-0 cursor-pointer rounded-sm hover:text-foreground"
            onClick={live.clearProblem}
            type="button"
          >
            <XIcon className="size-3.5" />
          </button>
        </p>
      )}
      <div
        className={cn(
          'flex flex-wrap items-center gap-x-3 gap-y-2.5 rounded-xl border px-3 py-3 transition-colors',
          step.step === 'working' || step.step === 'answer' || step.step === 'waiting'
            ? 'border-brand/35 bg-brand/5'
            : 'border-border bg-muted/20',
        )}
      >
        <div className="flex min-w-0 flex-[1_1_16rem] items-center gap-3">
          <StepMark mode={mode} step={step} />
          <StepText mode={mode} step={step} />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {off || asleep ? (
            <button
              className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-brand/50 px-3 text-[13px] hover:border-brand focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
              onClick={() => void (off ? start() : live.open(mode.waiting))}
              type="button"
            >
              <AudioLinesIcon className="size-4 text-brand" />
              {off ? 'Start' : mode.waiting ? 'Hear it' : 'Resume'}
            </button>
          ) : (
            <button
              aria-pressed={mode.muted}
              className={cn(
                'flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50',
                mode.muted && 'border-warning/50 text-warning',
              )}
              disabled={mode.phase !== 'live'}
              onClick={() => live.setMuted(!mode.muted)}
              type="button"
            >
              {mode.muted ? <MicIcon className="size-4" /> : <MicOffIcon className="size-4" />}
              {mode.muted ? 'Unmute' : 'Mute'}
            </button>
          )}
          {!off && (
            <button
              aria-label="End voice relay"
              className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-error px-3 text-[13px] text-white hover:bg-error/90 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
              onClick={live.end}
              type="button"
            >
              <PhoneOffIcon className="size-4" />
              <span className="max-sm:hidden">End</span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function useVoiceRow(main: number | undefined): ReactNode {
  const { voice } = useIds()
  const mode = useMode()
  const actions = useUltimate()
  if (main === undefined || voice === undefined) return null
  const on = mode.phase !== 'off'
  const inFront = on && mode.front && actions.conversationId === main
  const current = inFront || actions.conversationId === voice
  const hot = mode.phase === 'live' && !mode.muted
  const word = !on
    ? 'off'
    : mode.phase === 'live'
      ? mode.muted
        ? 'muted'
        : 'live'
      : mode.phase === 'paused'
        ? mode.waiting
          ? 'answer waiting'
          : 'paused'
        : mode.phase === 'starting'
          ? 'connecting'
          : 'ending'
  return (
    <button
      aria-current={current ? 'true' : undefined}
      className={cn(
        'mx-2 flex w-[calc(100%-1rem)] cursor-pointer items-center gap-1.5 rounded-md py-1.5 pr-2 pl-9 text-left outline-none hover:bg-sidebar-accent/50 focus-visible:ring-1 focus-visible:ring-ring',
        current && 'bg-sidebar-accent',
      )}
      data-voice-live-row={voice}
      key="voice"
      onClick={() => {
        if (!on) return actions.switchConversation(voice)
        toggleFront(actions)
      }}
      title={
        on
          ? `${mode.front ? 'Send Voice back' : 'Bring Voice to the front'} · ${keyHint}`
          : 'Open Voice'
      }
      type="button"
    >
      <AudioLinesIcon
        className={cn('size-3 shrink-0', on ? 'text-brand' : 'text-muted-foreground')}
      />
      <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground/80">
        Voice
      </span>
      <span
        className={cn(
          'flex shrink-0 items-center gap-1 font-mono text-[10px]',
          hot ? 'text-error' : mode.waiting ? 'text-brand' : 'text-muted-foreground',
        )}
      >
        {hot && <span className="size-1.5 rounded-full bg-error motion-safe:animate-pulse" />}
        {word}
      </span>
    </button>
  )
}

function useVoiceIds(): ReadonlySet<number> {
  const { voice } = useIds()
  return useMemo(() => new Set(voice === undefined ? [] : [voice]), [voice])
}

function LineRow({ entry }: { entry: EntryRecord }) {
  const actions = useUltimate()
  const mode = useMode()
  if (!VoiceLineEntry.is(entry)) return null
  const line = entry.data
  if (line.role === 'note') return null
  if (line.role === 'user' && line.forwarded) return <RequestCard entry={entry} line={line} />
  if ((line.role === 'ultimate' || line.role === 'notice') && line.re !== undefined) return null
  if (line.role === 'user')
    return (
      <Message className="mt-3 first:mt-0" data-voice-line="user" from="user">
        <MessageContent>
          <UserText text={line.text} />
        </MessageContent>
      </Message>
    )
  if (line.role === 'notice')
    return (
      <div
        className="mt-3 flex items-center gap-2 font-mono text-[11.5px] text-warning first:mt-0"
        data-voice-line="notice"
      >
        <CircleAlertIcon className="size-3.5 shrink-0" />
        {line.text}
      </div>
    )
  if (line.role === 'action')
    return (
      <div
        className="mt-2 flex items-center gap-2 font-mono text-[11.5px] text-muted-foreground first:mt-0"
        data-voice-line="action"
      >
        {line.go ? (
          <ArrowRightIcon className="size-3 shrink-0 text-brand" />
        ) : (
          <CheckIcon className="size-3 shrink-0 text-success" />
        )}
        <span className="min-w-0 truncate">{line.text}</span>
      </div>
    )
  if (line.role === 'live')
    return (
      <div className="mt-2 flex gap-2 first:mt-0" data-voice-line="live">
        <AudioLinesIcon className="mt-[3px] size-3 shrink-0 text-muted-foreground/50" />
        <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed break-words text-muted-foreground/70">
          {line.text}
        </p>
      </div>
    )

  const source = line.source
  return (
    <div className="mt-2 flex gap-2 first:mt-0" data-voice-line="ultimate">
      <Volume2Icon className="mt-[3px] size-3 shrink-0 text-muted-foreground/60" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-relaxed break-words text-muted-foreground">
          <Spoken entry={entry.id} text={line.text} />
        </p>
        {source && (
          <button
            className="mt-1 flex cursor-pointer items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => {
              const answerBehindVoice = mode.front && actions.conversationId === source.conversation
              live.setFront(false)
              openAgentSource(
                actions.switchConversation,
                source,
                answerBehindVoice
                  ? source
                  : { conversation: entry.conversationId, entry: entry.id },
              )
            }}
            title="Show @ultimate's full answer"
            type="button"
          >
            <SquareArrowOutUpRightIcon className="size-3" />
            full answer
          </button>
        )}
      </div>
    </div>
  )
}

function RequestCard({ entry, line }: { entry: EntryRecord; line: VoiceLine }) {
  const transcript = useTranscript()
  const { main } = useIds()
  const lines = transcript
    .filter((candidate) => VoiceLineEntry.is(candidate))
    .filter((e) => e.data.re === entry.id)
  const spokenEntry = lines.find((e) => e.data.role === 'ultimate')
  const spoken = spokenEntry?.data
  const notice = lines.find((e) => e.data.role === 'notice')?.data
  const answer = transcript
    .filter((candidate) => VoiceAnswerEntry.is(candidate))
    .find((e) => e.data.re === entry.id)?.data
  const state = notice ? 'failed' : answer || spoken ? 'answered' : 'working'
  if (main === undefined) return null
  return (
    <div className="mt-3 first:mt-0" data-voice-line="forwarded" data-forwarded={state}>
      <Bubble at={line.at} from={main} lead={<Asked text={line.text} />}>
        {state === 'working' ? (
          <Working main={main} since={line.at} />
        ) : state === 'failed' ? (
          <Failed notice={notice!} spoken={spoken} />
        ) : (
          <Answer answer={answer} entry={entry} spoken={spoken} spokenId={spokenEntry?.id} />
        )}
      </Bubble>
    </div>
  )
}

function Asked({ text }: { text: string }) {
  return (
    <div className="px-3 pt-2">
      <div className="flex items-center gap-1.5 font-mono text-[11px] text-brand">
        <MicIcon className="size-3 shrink-0" />
        <span className="font-semibold">You asked</span>
        <span className="text-muted-foreground">by voice</span>
      </div>
      <UserText
        className="mt-1.5 rounded-md border border-border/70 bg-secondary/60 px-3 py-2 text-[13px] leading-relaxed"
        text={text}
      />
    </div>
  )
}

function Working({ main, since }: { main: ConversationId; since?: number }) {
  const busy = useConversationSummary(main)?.busy
  const now = useNow(1000, since !== undefined)
  return (
    <div
      className="flex items-center gap-2 px-3 py-3 font-mono text-[11px] text-muted-foreground"
      role="status"
    >
      <LoaderCircleIcon className="size-3.5 shrink-0 text-brand motion-safe:animate-spin" />
      <Provided input={busy ? main : undefined} point={ConversationPhase}>
        {(phase) => (
          <span className="min-w-0 truncate text-brand">
            {phase?.label ?? (busy ? 'Working' : 'Waiting for @ultimate')}
          </span>
        )}
      </Provided>
      {since !== undefined && <span className="ml-auto tabular-nums">{clock(now - since)}</span>}
    </div>
  )
}

function Answer({
  answer,
  spoken,
  spokenId,
  entry,
}: {
  answer?: VoiceAnswer
  spoken?: VoiceLine
  spokenId?: number
  entry: EntryRecord
}) {
  const [open, setOpen] = useState(false)
  const actions = useUltimate()
  const mode = useMode()
  const source = answer?.source
  const full = answer && (open || !spoken)
  return (
    <>
      <div className={cn(!open && !spoken && 'line-clamp-4')}>
        {!full && spoken && spokenId !== undefined && mode.speaking?.entry === spokenId ? (
          <p className="min-w-0 px-3 py-3 text-[13px] leading-relaxed break-words">
            <Spoken entry={spokenId} text={spoken.text} />
          </p>
        ) : (
          <Body text={full ? answer.text : (spoken?.text ?? '')} />
        )}
      </div>
      {(answer || source) && (
        <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          {answer && spoken && (
            <button
              aria-expanded={open}
              className="flex cursor-pointer items-center gap-1 hover:text-foreground"
              onClick={() => setOpen(!open)}
              type="button"
            >
              <ChevronRightIcon
                className={cn('size-3 transition-transform', open && 'rotate-90')}
              />
              {open ? 'Spoken version' : 'Full answer'}
            </button>
          )}
          {answer && !spoken && <span>speaking…</span>}
          {source && (
            <button
              className="ml-auto flex cursor-pointer items-center gap-1 hover:text-foreground"
              onClick={() => {
                const answerBehindVoice =
                  mode.front && actions.conversationId === source.conversation
                live.setFront(false)
                openAgentSource(
                  actions.switchConversation,
                  source,
                  answerBehindVoice
                    ? source
                    : { conversation: entry.conversationId, entry: entry.id },
                )
              }}
              title="Open @ultimate's conversation at this answer"
              type="button"
            >
              <SquareArrowOutUpRightIcon className="size-3" />
              Open in @ultimate
            </button>
          )}
        </footer>
      )}
    </>
  )
}

function Failed({ notice, spoken }: { notice: VoiceLine; spoken?: VoiceLine }) {
  return (
    <>
      {spoken && <Body text={spoken.text} />}
      <footer className="flex items-center gap-1.5 border-t border-border/60 px-3 py-1.5 font-mono text-[11px] text-destructive">
        <CircleAlertIcon className="size-3 shrink-0" />
        {notice.text}
      </footer>
    </>
  )
}

function VoiceMark({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        '-mt-1 flex items-center gap-1 font-mono text-[10.5px] text-muted-foreground/70',
        className,
      )}
    >
      <MicIcon className="size-2.5" />
      {children}
    </span>
  )
}

function SessionRow({ entry }: { entry: EntryRecord }) {
  if (!VoiceSessionEntry.is(entry)) return null
  const session = entry.data
  const minutes =
    session.seconds === undefined ? undefined : Math.max(1, Math.round(session.seconds / 60))
  return (
    <div
      className="my-3 flex items-center gap-3 font-mono text-[11px] text-muted-foreground"
      data-voice-session={session.phase}
      role="separator"
    >
      <span className="h-px flex-1 border-t border-dashed border-border" />
      <span className="flex shrink-0 items-center gap-1.5">
        <AudioLinesIcon className={cn('size-3', session.phase === 'started' && 'text-brand')} />
        {session.phase === 'started'
          ? `Live · ${formatTime(session.at)}`
          : `Ended · ${minutes === undefined ? formatTime(session.at) : `${minutes} min`}`}
      </span>
      <span className="h-px flex-1 border-t border-dashed border-border" />
    </div>
  )
}

function ContextRow({ entry }: { entry: EntryRecord }) {
  const transcript = useTranscript()
  if (!VoiceContextEntry.is(entry)) return null
  const brief = entry.data
  const newest = transcript.findLast((e) => e.kind === 'voice.context')?.id === entry.id
  const counts = brief.error
    ? `couldn't load · ${brief.error}`
    : [
        `memory ${brief.memories}`,
        `${brief.requests} recent request${brief.requests === 1 ? '' : 's'}`,
        `${brief.branches} open branch${brief.branches === 1 ? '' : 'es'}`,
        ...(brief.questions !== undefined
          ? [`${brief.questions} open question${brief.questions === 1 ? '' : 's'}`]
          : []),
      ].join(' · ')
  return (
    <Collapsible
      className={cn(
        'group/context my-2 rounded-md border border-border/60 bg-muted/20',
        !newest && 'opacity-60',
      )}
      data-voice-context={newest ? 'current' : 'past'}
    >
      <CollapsibleTrigger className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-left font-mono text-[11px] text-muted-foreground hover:text-foreground">
        <ChevronRightIcon className="size-3 shrink-0 transition-transform group-data-[state=open]/context:rotate-90" />
        <BookOpenIcon
          className={cn('size-3 shrink-0', brief.error ? 'text-error' : 'text-brand')}
        />
        <span className="shrink-0 text-foreground/80">
          {brief.again ? 'Context again' : 'Context'}
        </span>
        <span className="min-w-0 truncate">· {counts}</span>
        {!brief.error && (
          <span className="ml-auto shrink-0 pl-2 tabular-nums opacity-70">
            ~{(brief.tokens / 1000).toFixed(1)}k tokens
          </span>
        )}
      </CollapsibleTrigger>
      {!brief.error && (
        <CollapsibleContent className="max-h-[28rem] overflow-y-auto border-t border-border/60 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
          <MessageResponse>
            {brief.text.replace(/^<voice_context>\n|\n<\/voice_context>$/g, '')}
          </MessageResponse>
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}

function UtteranceRow({ entry }: { entry: EntryRecord }) {
  if (!VoiceUtteranceEntry.is(entry)) return null
  const data = entry.data
  const message = entry.model?.[0]
  if (message?.role !== 'user') return null
  return (
    <div data-voice-utterance>
      <UserView entry={entry} message={message} text={data.text} />
      <VoiceMark className="-mt-3 justify-end">by voice</VoiceMark>
    </div>
  )
}

function HeardRow({ entry }: { entry: EntryRecord }) {
  if (!VoiceHeardEntry.is(entry)) return null
  const { text } = entry.data
  return (
    <Message className="mt-4 first:mt-0" data-voice-line="user" from="user">
      <MessageContent className="group-[.is-user]:bg-secondary/50 group-[.is-user]:text-[13px] group-[.is-user]:text-foreground/80">
        <UserText text={text} />
      </MessageContent>
    </Message>
  )
}

function Spoken({ entry, text }: { entry: number; text: string }) {
  const { speaking } = useMode()
  if (speaking?.entry !== entry) return text
  const words = text.split(' ')
  return words.map((word, index) => (
    <span
      className={cn('transition-opacity duration-300', index >= speaking.words && 'opacity-25')}
      key={index}
    >
      {index ? ' ' : ''}
      {word}
    </span>
  ))
}

function LiveTurn() {
  const id = useConversation((conversation) => conversation.id)
  const transcript = useTranscript()
  const { voice } = useIds()
  const { partial, sending } = useMode()
  if (id === undefined || id !== voice) return null
  const last = transcript.findLast((candidate) => VoiceHeardEntry.is(candidate))
  const data: { text?: string } | undefined = last?.data
  const sendingEntryArrived = sending && data?.text === sending.text
  const text = partial ?? (sendingEntryArrived ? undefined : sending?.text)
  if (!text) return null
  return (
    <Message className="mt-4" data-voice-line="hearing" from="user">
      <MessageContent className="group-[.is-user]:bg-secondary/50 group-[.is-user]:text-[13px] group-[.is-user]:text-foreground/80">
        <p
          className="flex max-h-[13.5rem] flex-col justify-end overflow-hidden break-words whitespace-pre-wrap [mask-image:linear-gradient(to_bottom,transparent,black_4.5rem)]"
          data-voice-partial
        >
          <span>
            {text.split(' ').map((word, index) => (
              <span className="animate-fade-in" key={index}>
                {index ? ' ' : ''}
                {word}
              </span>
            ))}
            {partial !== undefined && (
              <span className="ml-1 inline-block size-1.5 rounded-full bg-brand align-middle motion-safe:animate-pulse" />
            )}
          </span>
        </p>
      </MessageContent>
    </Message>
  )
}

function QuestionRow({ entry }: { entry: EntryRecord }) {
  if (!VoiceQuestionEntry.is(entry)) return null
  const question = entry.data
  return (
    <div
      className="mt-2 flex items-center gap-2 font-mono text-[11.5px] text-warning first:mt-0"
      data-voice-line="question"
    >
      <CircleAlertIcon className="size-3 shrink-0" />
      <span className="min-w-0 truncate">
        {question.title} asks · {question.gist}
      </span>
    </div>
  )
}

const QuietAgentRow: EntryRenderer = ({ core }) => {
  const id = useConversation((conversation) => conversation.id)
  const { voice } = useIds()
  return id === voice ? (
    <div className="text-xs text-muted-foreground opacity-60">{core}</div>
  ) : (
    core
  )
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
  provides: [provide(UnderUltimate, useVoiceRow), provide(Unlisted, useVoiceIds)],
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
      run: () => start(),
    },
    {
      id: 'voice-live.front',
      title: 'Voice relay: bring to front or send back',
      keys: KEYS,
      when: () => live.voiceMode().phase !== 'off',
      run: (context) => toggleFront(context),
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
