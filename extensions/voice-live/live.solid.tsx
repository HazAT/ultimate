/** @jsxImportSource @solidjs/web */
import { createRoot, createSignal } from 'solid-js'
import { deadline, every } from '../../lib/timers.ts'
import type { Cancel } from '../../lib/timers.ts'
import { api, errorMessage, events } from '@/sdk/solid'
import type { ActionRef } from '../../shared/extension-api.ts'
import { playNotes, voiceQuestions } from '../sounds/ui.solid.tsx'
import type { Note } from '../sounds/ui.solid.tsx'
import { StatusAction } from './refs.ts'
import type { VoiceStatus } from './refs.ts'
import { IDLE_MS } from './relay.ts'
import type { LiveEvent } from './relay.ts'
import { startMicInGesture } from './session.ts'
import type { LiveSession } from './session.ts'

export type Phase = 'off' | 'starting' | 'live' | 'paused' | 'ending'
export type VoiceMode = {
  phase: Phase
  billedSince?: number
  muted: boolean
  problem?: string
  waiting?: string
  front: boolean
  floor?: 'user' | 'voice'
  partial?: string
  sending?: { text: string; at: number }
  speaking?: { entry: number; words: number; at: number }
}

let pageMode: VoiceMode = { phase: 'off', muted: false, front: false }
let session: LiveSession | undefined

let startupSpeech: { text: string; entry?: number }[] = []
let cancelled = false
let closeInFlight: Promise<void> | undefined
let stopTicking: Cancel | undefined
const [mode, setMode] = createRoot(() => createSignal(pageMode))
export { mode }

const alwaysOnCues: Record<'ready' | 'paused' | 'ended' | 'failed', Note[]> = {
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
  if (to === 'live') return alwaysOnCues.ready
  if (to === 'paused' && from === 'live') return alwaysOnCues.paused
  if (to === 'off' && from !== 'starting') return alwaysOnCues.ended
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

function publishMode(next: Partial<VoiceMode>, failed = false) {
  const cue = failed ? alwaysOnCues.failed : next.phase && cueOf(pageMode.phase, next.phase)

  if (next.phase === 'starting' && pageMode.phase !== 'starting') startConnectingHum()
  else if (next.phase && next.phase !== 'starting') stopConnectingHum()
  pageMode = { ...pageMode, ...next }

  voiceQuestions(pageMode.phase !== 'off')

  if (cue) playNotes(cue, 0.08).catch((error: unknown) => console.warn('Voice cue failed', error))
  setMode(pageMode)
}
export const voiceMode = () => pageMode
export const setFront = (front: boolean) => publishMode({ front })
export const clearProblem = () => publishMode({ problem: undefined })

let gestureKeyStatus: VoiceStatus | undefined
export const rememberStatus = (next: VoiceStatus) => (gestureKeyStatus = next)

export async function start() {
  gestureKeyStatus ??= await api.action(StatusAction)
  if (!gestureKeyStatus.available) return events.emit('secrets:open', { name: 'OPENAI_API_KEY' })
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
  publishMode({
    phase: next,
    billedSince: undefined,
    floor: undefined,
    partial: undefined,
    speaking: undefined,
    ...(problem ? { problem } : {}),
  })
  if (!current) return
  closeInFlight = current
    .close()
    .catch((error: unknown) => publishMode({ problem: describe(error) }))
    .finally(() => (closeInFlight = undefined))
}

function tick() {
  if (!session) return
  const sessionEnded = session.analyser.context.state === 'closed'
  if (sessionEnded) {
    session = undefined
    stopTicking?.()
    publishMode({
      phase: 'paused',
      billedSince: undefined,
      floor: undefined,
      partial: undefined,
      speaking: undefined,
      problem: pageMode.problem ?? 'The session closed',
    })
    return
  }
  const now = Date.now()
  const floor = session.relay.hearing() ? 'user' : session.relay.talking() ? 'voice' : undefined
  const partial = session.relay.partial() || undefined
  if (floor !== pageMode.floor || partial !== pageMode.partial)
    publishMode({
      floor,
      partial,
      sending: partial
        ? undefined
        : pageMode.partial
          ? { text: pageMode.partial, at: now }
          : pageMode.sending,
    })
  else if (pageMode.sending && now - pageMode.sending.at > 6000) publishMode({ sending: undefined })

  if (pageMode.speaking) {
    const words = session.relay.spokenWords()

    const unreadSpeechMs = 8000
    const speechTimedOut = words === 0 && now - pageMode.speaking.at > unreadSpeechMs
    if ((words > 0 && !session.relay.talking()) || speechTimedOut)
      publishMode({ speaking: undefined })
    else if (words !== pageMode.speaking.words)
      publishMode({ speaking: { ...pageMode.speaking, words } })
  }

  const nudgeDue =
    requestOrNudgeAtMs !== undefined &&
    now - requestOrNudgeAtMs >= (nudgedRequest ? 45_000 : 20_000)
  if (nudgeDue) {
    requestOrNudgeAtMs = now
    nudgedRequest = true
    try {
      session.speak('Still on it.')
    } catch (error) {
      publishMode({ problem: describe(error) })
    }
  }
  if (session.relay.idleFor(now) >= IDLE_MS) release('paused')
}

const transcriptFollowMs = 150

let requestOrNudgeAtMs: number | undefined
let nudgedRequest = false

function onEvent(event: LiveEvent) {
  if (event.type === 'session.closed' && session && pageMode.phase === 'live')
    publishMode({
      problem: event.reason ? `Session closed: ${event.reason}` : 'The session closed',
    })
}

const callTypedAction = <A, R>(ref: ActionRef<A, R>, args: A) =>
  api.action(ref as ActionRef<null, R>, args as null)

export async function open(speech?: string, entry?: number): Promise<void> {
  if (speech) startupSpeech.push({ text: speech, entry })
  const sessionOccupied =
    pageMode.phase === 'starting' || pageMode.phase === 'live' || pageMode.phase === 'ending'
  if (sessionOccupied) return
  const from = pageMode.phase
  cancelled = false
  publishMode({
    phase: 'starting',
    problem: undefined,
    waiting: undefined,
    ...(from === 'off' ? { front: true } : {}),
  })

  if (closeInFlight) await closeInFlight
  let started: LiveSession
  try {
    started = await startMicInGesture({
      action: callTypedAction,
      onEvent,
      onError: (error) => publishMode({ problem: describe(error) }),
    })
  } catch (error) {
    const waiting = startupSpeech.at(-1)?.text
    startupSpeech = []
    if (cancelled) return publishMode({ phase: 'off', problem: undefined, front: false })

    return publishMode(
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
  publishMode({ phase: 'live', billedSince: Date.now() })
  try {
    if (pageMode.muted) started.mute()
    for (const item of startupSpeech) say(started, item.text, item.entry)
  } catch (error) {
    publishMode({ problem: describe(error) })
  }
  startupSpeech = []
}

export function working(forwardedRequestPending: boolean) {
  if (forwardedRequestPending && requestOrNudgeAtMs === undefined) {
    requestOrNudgeAtMs = Date.now()
    nudgedRequest = false
  } else if (!forwardedRequestPending) requestOrNudgeAtMs = undefined
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
    publishMode({ problem: describe(error) })
  }
}

function say(live: LiveSession, text: string, entry?: number) {
  live.speak(text)
  publishMode({
    speaking: entry === undefined ? undefined : { entry, words: 0, at: Date.now() },
  })
}

export function hear(text: string, entry?: number) {
  if (pageMode.phase === 'live' && session) {
    try {
      say(session, text, entry)
    } catch (error) {
      publishMode({ problem: describe(error) })
    }
  } else if (pageMode.phase === 'starting') startupSpeech.push({ text, entry })
  else if (pageMode.phase === 'paused') {
    const needsWakeGesture = navigator.userActivation && !navigator.userActivation.hasBeenActive
    if (needsWakeGesture) publishMode({ waiting: text })
    else void open(text, entry)
  }
}

export function setMuted(muted: boolean) {
  try {
    if (session) {
      if (muted) session.mute()
      else session.unmute()
    }
    publishMode({ muted })
  } catch (error) {
    publishMode({ problem: describe(error) })
  }
}

export function end() {
  if (pageMode.phase === 'off') return
  startupSpeech = []
  if (pageMode.phase === 'starting') {
    cancelled = true
    return publishMode({ phase: 'ending' })
  }
  release('off')
  publishMode({ problem: undefined, waiting: undefined, muted: false, front: false })
}

addEventListener('pagehide', () => {
  stopConnectingHum()
  if (session) release('off')
})
