import { deadline, every } from '../../lib/timers.ts'
import type { Cancel } from '../../lib/timers.ts'
import { api, errorMessage, events } from '@/sdk'
import type { ActionRef } from '@/sdk'
import { playNotes, voiceQuestions } from '../sounds/ui.tsx'
import type { Note } from '../sounds/ui.tsx'
import { StatusAction } from './refs.ts'
import type { VoiceStatus } from './refs.ts'
import { IDLE_MS } from './relay.ts'
import type { LiveEvent } from './relay.ts'
import { startLive } from './session.ts'
import type { LiveSession } from './session.ts'

export type Phase = 'off' | 'starting' | 'live' | 'paused' | 'ending'
export type VoiceMode = {
  phase: Phase
  sessionBilledSinceMs?: number
  muted: boolean
  problem?: string
  waiting?: string
  front: boolean
  floor?: 'user' | 'voice'
  partial?: string
  sending?: { text: string; at: number }
  speaking?: { entry: number; words: number; at: number }
}

let pageModeAcrossSessions: VoiceMode = { phase: 'off', muted: false, front: false }
let session: LiveSession | undefined

let answersAfterStartup: { text: string; entry?: number }[] = []
let cancelled = false
let closing: Promise<void> | undefined
let stopTicking: Cancel | undefined
const listeners = new Set<() => void>()

const unmutedByNotificationSwitchCues: Record<'ready' | 'paused' | 'ended' | 'failed', Note[]> = {
  ready: [
    [0, 783.99, 0.25],
    [0.1, 1046.5, 0.45],
  ],
  paused: [
    [0, 1046.5, 0.25],
    [0.12, 783.99, 0.5],
  ],
  ended: [
    [0, 783.99, 0.22],
    [0.11, 659.25, 0.22],
    [0.22, 523.25, 0.6],
  ],
  failed: [
    [0, 329.63, 0.25],
    [0.14, 277.18, 0.5],
  ],
}

function cueOf(from: Phase, to: Phase) {
  if (from === to) return undefined
  if (to === 'live') return unmutedByNotificationSwitchCues.ready
  if (to === 'paused' && from === 'live') return unmutedByNotificationSwitchCues.paused
  if (to === 'off' && from !== 'starting') return unmutedByNotificationSwitchCues.ended
  return undefined
}

let connectingHum: { context: AudioContext; out: GainNode } | undefined

function startConnectingHum() {
  if (connectingHum) return
  const context = new AudioContext()
  const now = context.currentTime
  const out = context.createGain()
  const clickFreeFadeInSeconds = 0.4
  out.gain.setValueAtTime(0, now)
  out.gain.linearRampToValueAtTime(0.05, now + clickFreeFadeInSeconds)
  out.connect(context.destination)

  const swell = context.createGain()
  swell.gain.value = 0.5
  const breathingOscillator = context.createOscillator()
  const depth = context.createGain()
  breathingOscillator.frequency.value = 0.8
  depth.gain.value = 0.45
  breathingOscillator.connect(depth).connect(swell.gain)
  swell.connect(out)
  for (const [frequency, level] of [
    [392, 1],
    [587.33, 0.35],
  ]) {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.frequency.value = frequency
    gain.gain.value = level
    oscillator.connect(gain).connect(swell)
    oscillator.start(now)
  }
  breathingOscillator.start(now)
  connectingHum = { context, out }

  if (context.state === 'suspended')
    context.resume().catch((error: unknown) => console.warn('Connecting hum blocked', error))
}

function stopConnectingHum() {
  const current = connectingHum
  connectingHum = undefined
  if (!current) return
  const { context, out } = current
  const now = context.currentTime
  out.gain.cancelScheduledValues(now)
  out.gain.setValueAtTime(out.gain.value, now)
  out.gain.linearRampToValueAtTime(0, now + 0.08)
  deadline(120, () => {
    context.close().catch((error: unknown) => console.warn('Connecting hum close failed', error))
  })
}

function publishModeAndCue(next: Partial<VoiceMode>, failed = false) {
  const cue = failed
    ? unmutedByNotificationSwitchCues.failed
    : next.phase && cueOf(pageModeAcrossSessions.phase, next.phase)

  if (next.phase === 'starting' && pageModeAcrossSessions.phase !== 'starting') startConnectingHum()
  else if (next.phase && next.phase !== 'starting') stopConnectingHum()
  pageModeAcrossSessions = { ...pageModeAcrossSessions, ...next }

  voiceQuestions(pageModeAcrossSessions.phase !== 'off')

  if (cue) playNotes(cue, 0.08).catch((error: unknown) => console.warn('Voice cue failed', error))
  for (const listener of listeners) listener()
}

export const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
export const voiceMode = () => pageModeAcrossSessions
export const setFront = (front: boolean) => publishModeAndCue({ front })
export const clearProblem = () => publishModeAndCue({ problem: undefined })

let cachedKeyStatusForGesture: VoiceStatus | undefined
export const rememberStatus = (next: VoiceStatus) => (cachedKeyStatusForGesture = next)

export async function start() {
  cachedKeyStatusForGesture ??= await api.action(StatusAction)
  if (!cachedKeyStatusForGesture.available)
    return events.emit('secrets:open', { name: 'OPENAI_API_KEY' })
  await open()
}

export const analyser = () => session?.analyser

const describe = (error: unknown) => {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError') return 'Microphone or audio blocked by the browser'
  if (name === 'NotFoundError') return 'No microphone found'
  return errorMessage(error).replace(/^voice-live\/\w+: /, '')
}

function release(next: VoiceMode['phase'], problem?: string) {
  const current = session
  session = undefined
  stopTicking?.()
  publishModeAndCue({
    phase: next,
    sessionBilledSinceMs: undefined,
    floor: undefined,
    partial: undefined,
    speaking: undefined,
    ...(problem ? { problem } : {}),
  })
  if (!current) return
  closing = current
    .close()
    .catch((error: unknown) => publishModeAndCue({ problem: describe(error) }))
    .finally(() => (closing = undefined))
}

function tick() {
  if (!session) return
  const sessionAlreadyReleasedAndEnded = session.analyser.context.state === 'closed'
  if (sessionAlreadyReleasedAndEnded) {
    session = undefined
    stopTicking?.()
    publishModeAndCue({
      phase: 'paused',
      sessionBilledSinceMs: undefined,
      floor: undefined,
      partial: undefined,
      speaking: undefined,
      problem: pageModeAcrossSessions.problem ?? 'The session closed',
    })
    return
  }
  const now = Date.now()
  const floor = session.relay.hearing() ? 'user' : session.relay.talking() ? 'voice' : undefined
  const partial = session.relay.partial() || undefined
  if (floor !== pageModeAcrossSessions.floor || partial !== pageModeAcrossSessions.partial)
    publishModeAndCue({
      floor,
      partial,
      sending: partial
        ? undefined
        : pageModeAcrossSessions.partial
          ? { text: pageModeAcrossSessions.partial, at: now }
          : pageModeAcrossSessions.sending,
    })
  else if (pageModeAcrossSessions.sending && now - pageModeAcrossSessions.sending.at > 6000)
    publishModeAndCue({ sending: undefined })

  if (pageModeAcrossSessions.speaking) {
    const words = session.relay.spokenWords()

    const unreadSpeechTimeoutMs = 8000
    const unreadSpeechTimedOut =
      words === 0 && now - pageModeAcrossSessions.speaking.at > unreadSpeechTimeoutMs
    if ((words > 0 && !session.relay.talking()) || unreadSpeechTimedOut)
      publishModeAndCue({ speaking: undefined })
    else if (words !== pageModeAcrossSessions.speaking.words)
      publishModeAndCue({ speaking: { ...pageModeAcrossSessions.speaking, words } })
  }

  const pendingRequestNudgeMs = hasNudgedPendingRequest ? 45_000 : 20_000
  if (
    pendingRequestOrNudgeAtMs !== undefined &&
    now - pendingRequestOrNudgeAtMs >= pendingRequestNudgeMs
  ) {
    pendingRequestOrNudgeAtMs = now
    hasNudgedPendingRequest = true
    try {
      session.speak('Still on it.')
    } catch (error) {
      publishModeAndCue({ problem: describe(error) })
    }
  }
  if (session.relay.idleFor(now) >= IDLE_MS) release('paused')
}

const transcriptFollowMs = 150

let pendingRequestOrNudgeAtMs: number | undefined
let hasNudgedPendingRequest = false

function onEvent(event: LiveEvent) {
  if (event.type === 'session.closed' && session && pageModeAcrossSessions.phase === 'live')
    publishModeAndCue({
      problem: event.reason ? `Session closed: ${event.reason}` : 'The session closed',
    })
}

const callTypedActionWithRestArgs = <A, R>(ref: ActionRef<A, R>, args: A) =>
  api.action(ref as ActionRef<null, R>, args as null)

export async function open(speech?: string, entry?: number): Promise<void> {
  if (speech) answersAfterStartup.push({ text: speech, entry })
  const sessionAlreadyActiveOrTransitioning =
    pageModeAcrossSessions.phase === 'starting' ||
    pageModeAcrossSessions.phase === 'live' ||
    pageModeAcrossSessions.phase === 'ending'
  if (sessionAlreadyActiveOrTransitioning) return
  const from = pageModeAcrossSessions.phase
  cancelled = false
  publishModeAndCue({
    phase: 'starting',
    problem: undefined,
    waiting: undefined,
    ...(from === 'off' ? { front: true } : {}),
  })

  if (closing) await closing
  let started: LiveSession
  try {
    started = await startLive({
      action: callTypedActionWithRestArgs,
      onEvent,
      onError: (error) => publishModeAndCue({ problem: describe(error) }),
    })
  } catch (error) {
    const waiting = answersAfterStartup.at(-1)?.text
    answersAfterStartup = []
    if (cancelled) return publishModeAndCue({ phase: 'off', problem: undefined, front: false })

    return publishModeAndCue(
      {
        phase: from === 'paused' ? 'paused' : 'off',
        problem: describe(error),
        ...(waiting ? { waiting } : {}),
      },
      true,
    )
  }
  session = started
  if (cancelled) return release('off')
  stopTicking = every(transcriptFollowMs, tick)
  publishModeAndCue({ phase: 'live', sessionBilledSinceMs: Date.now() })
  try {
    if (pageModeAcrossSessions.muted) started.mute()
    for (const item of answersAfterStartup) say(started, item.text, item.entry)
  } catch (error) {
    publishModeAndCue({ problem: describe(error) })
  }
  answersAfterStartup = []
}

export function working(forwardedRequestPending: boolean) {
  if (forwardedRequestPending && pendingRequestOrNudgeAtMs === undefined) {
    pendingRequestOrNudgeAtMs = Date.now()
    hasNudgedPendingRequest = false
  } else if (!forwardedRequestPending) pendingRequestOrNudgeAtMs = undefined
}

export function note(text: string) {
  if (!session) return
  try {
    session.send({
      type: 'session.thinking.append',
      event_id: crypto.randomUUID(),
      content: text,
    })
  } catch (error) {
    publishModeAndCue({ problem: describe(error) })
  }
}

function say(live: LiveSession, text: string, entry?: number) {
  live.speak(text)
  publishModeAndCue({
    speaking: entry === undefined ? undefined : { entry, words: 0, at: Date.now() },
  })
}

export function hear(text: string, entry?: number) {
  if (pageModeAcrossSessions.phase === 'live' && session) {
    try {
      say(session, text, entry)
    } catch (error) {
      publishModeAndCue({ problem: describe(error) })
    }
  } else if (pageModeAcrossSessions.phase === 'starting') answersAfterStartup.push({ text, entry })
  else if (pageModeAcrossSessions.phase === 'paused') {
    const browserNeedsWakeGesture =
      navigator.userActivation && !navigator.userActivation.hasBeenActive
    if (browserNeedsWakeGesture) publishModeAndCue({ waiting: text })
    else void open(text, entry)
  }
}

export function setMuted(muted: boolean) {
  try {
    if (session) {
      if (muted) session.mute()
      else session.unmute()
    }
    publishModeAndCue({ muted })
  } catch (error) {
    publishModeAndCue({ problem: describe(error) })
  }
}

export function end() {
  if (pageModeAcrossSessions.phase === 'off') return
  answersAfterStartup = []
  if (pageModeAcrossSessions.phase === 'starting') {
    cancelled = true
    return publishModeAndCue({ phase: 'ending' })
  }
  release('off')
  publishModeAndCue({ problem: undefined, waiting: undefined, muted: false, front: false })
}

addEventListener('pagehide', () => {
  stopConnectingHum()
  if (session) release('off')
})
