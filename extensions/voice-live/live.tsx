/**
 * This tab's voice mode: at most one live session, outside React, so a hot reload of `web.tsx` never orphans a running
 * session and its microphone. Voice mode outlasts its sessions: an idle session closes and the mode sleeps until an
 * answer arrives to speak or the user taps resume. Only End leaves it.
 */
import { api, errorMessage, events } from '@/sdk'
import type { ActionRef } from '@/sdk'
import { playNotes } from '../sounds/ui.tsx'
import type { Note } from '../sounds/ui.tsx'
import { StatusAction } from './refs.ts'
import type { VoiceStatus } from './refs.ts'
import { IDLE_MS } from './relay.ts'
import type { LiveEvent } from './relay.ts'
import { startLive } from './session.ts'
import type { LiveSession } from './session.ts'

/** `paused`: in voice mode without a session, listening paused until an answer or a tap wakes it. */
export type Phase = 'off' | 'starting' | 'live' | 'paused' | 'ending'
export type VoiceMode = {
  phase: Phase
  /** When the current session went live: its billed time. */
  since?: number
  /** Kept across sessions, so a session that wakes for an answer never opens a muted microphone. */
  muted: boolean
  /** Why the session stopped, or what failed: shown in the indicator, never only in the console. */
  problem?: string
  /** An answer that arrived while paused, when this browser would not restart without a tap. */
  waiting?: string
  /** The Voice conversation sits in front of @ultimate's. Not durable: voice mode ends with its page. */
  front: boolean
  /** Who has the floor in the live session: the user mid-sentence, or GPT-Live talking. */
  floor?: 'user' | 'voice'
  /** The words of the line the user is saying now, before a pause finishes it. */
  partial?: string
  /** A line just finished and on its way to Voice: shown until its `voice.heard` entry arrives. */
  sending?: { text: string; at: number }
  /** The Voice line GPT-Live is reading out now, and how many of its words it has said so far. */
  speaking?: { entry: number; words: number; at: number }
}

let mode: VoiceMode = { phase: 'off', muted: false, front: false }
let session: LiveSession | undefined
/** Answers to speak once the session starting now is live, with the Voice line each one is. */
let queued: { text: string; entry?: number }[] = []
let cancelled = false
let closing: Promise<void> | undefined
let ticker: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()

/**
 * Cues for the ear, softer and shorter than the notification bells: ready rises a fourth (G5, C6), paused falls back
 * (C6, G5), ended steps down to rest (G5, E5, C5), failed drops low (E4, C♯4). Part of using voice, so the sounds
 * switch does not mute them.
 */
const cues: Record<'ready' | 'paused' | 'ended' | 'failed', Note[]> = {
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

/** The cue a phase change sounds: going live, an idle or dropped session pausing, voice mode ending. */
function cueOf(from: Phase, to: Phase) {
  if (from === to) return undefined
  if (to === 'live') return cues.ready
  if (to === 'paused' && from === 'live') return cues.paused
  if (to === 'off' && from !== 'starting') return cues.ended
  return undefined
}

/**
 * The connecting cue: a quiet hum, G4 under its fifth, breathing at 0.8 Hz until the session is live. Its own audio
 * context, created inside the tap that starts voice so the browser lets it play; closing it silences everything.
 */
let hum: { context: AudioContext; out: GainNode } | undefined

function startHum() {
  if (hum) return
  const context = new AudioContext()
  const now = context.currentTime
  const out = context.createGain()
  // Fades in, so it never clicks.
  out.gain.setValueAtTime(0, now)
  out.gain.linearRampToValueAtTime(0.05, now + 0.4)
  out.connect(context.destination)
  // The pulse: a slow oscillator swings the swell between near silence and full.
  const swell = context.createGain()
  swell.gain.value = 0.5
  const lfo = context.createOscillator()
  const depth = context.createGain()
  lfo.frequency.value = 0.8
  depth.gain.value = 0.45
  lfo.connect(depth).connect(swell.gain)
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
  lfo.start(now)
  hum = { context, out }
  // Without a gesture behind it (an answer waking a paused session) the browser may keep it shut: silence is fine.
  if (context.state === 'suspended')
    context.resume().catch((error: unknown) => console.warn('Connecting hum blocked', error))
}

/** Fades the hum out in 80 ms and releases its audio context; nothing happens when none plays. */
function stopHum() {
  const current = hum
  hum = undefined
  if (!current) return
  const { context, out } = current
  const now = context.currentTime
  out.gain.cancelScheduledValues(now)
  out.gain.setValueAtTime(out.gain.value, now)
  out.gain.linearRampToValueAtTime(0, now + 0.08)
  setTimeout(() => {
    context.close().catch((error: unknown) => console.warn('Connecting hum close failed', error))
  }, 120)
}

function set(next: Partial<VoiceMode>, failed = false) {
  const cue = failed ? cues.failed : next.phase && cueOf(mode.phase, next.phase)
  // The connecting hum lasts exactly as long as `starting`: it hands over to the ready, failed or no cue.
  if (next.phase === 'starting' && mode.phase !== 'starting') startHum()
  else if (next.phase && next.phase !== 'starting') stopHum()
  mode = { ...mode, ...next }
  // The indicator already shows the phase; a cue the browser refuses is only worth a warning.
  if (cue) playNotes(cue, 0.08).catch((error: unknown) => console.warn('Voice cue failed', error))
  for (const listener of listeners) listener()
}

export const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
export const voiceMode = () => mode
export const setFront = (front: boolean) => set({ front })
export const clearProblem = () => set({ problem: undefined })

/** The last key status the composer read: a command then starts without a round trip, inside the user's gesture. */
let status: VoiceStatus | undefined
export const rememberStatus = (next: VoiceStatus) => (status = next)

/** Start from a click or a command: a missing key opens its row in Secrets instead of asking for the microphone. */
export async function start() {
  status ??= await api.action(StatusAction)
  if (!status.available) return events.emit('secrets:open', { name: 'OPENAI_API_KEY' })
  await open()
}
/** The live session's microphone analyser, for a level meter. */
export const analyser = () => session?.analyser

const describe = (error: unknown) => {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError') return 'Microphone or audio blocked by the browser'
  if (name === 'NotFoundError') return 'No microphone found'
  return errorMessage(error).replace(/^voice-live\/\w+: /, '')
}

/** Close the session we hold; `phase` is where the mode goes once it has. */
function release(next: VoiceMode['phase'], problem?: string) {
  const current = session
  session = undefined
  clearInterval(ticker)
  set({
    phase: next,
    since: undefined,
    floor: undefined,
    partial: undefined,
    speaking: undefined,
    ...(problem ? { problem } : {}),
  })
  if (!current) return
  closing = current
    .close()
    .catch((error: unknown) => set({ problem: describe(error) }))
    .finally(() => (closing = undefined))
}

/** Each tick: follow who has the floor, notice a session that closed under us (expiry, a dropped peer), and close one gone idle. */
function tick() {
  if (!session) return
  if (session.analyser.context.state === 'closed') {
    // startLive already released it and recorded the end; the mode sleeps, as after idling.
    session = undefined
    clearInterval(ticker)
    set({
      phase: 'paused',
      since: undefined,
      floor: undefined,
      partial: undefined,
      speaking: undefined,
      problem: mode.problem ?? 'The session closed',
    })
    return
  }
  const now = Date.now()
  const floor = session.relay.hearing() ? 'user' : session.relay.talking() ? 'voice' : undefined
  const partial = session.relay.partial() || undefined
  if (floor !== mode.floor || partial !== mode.partial)
    set({
      floor,
      partial,
      sending: partial ? undefined : mode.partial ? { text: mode.partial, at: now } : mode.sending,
    })
  else if (mode.sending && now - mode.sending.at > 6000) set({ sending: undefined })
  // Follow the line being read out word by word; once GPT-Live falls quiet after it, show it whole.
  if (mode.speaking) {
    const words = session.relay.spokenWords()
    // GPT-Live may never read it (it was interrupted, or paraphrased into silence): then show it whole after 8 s.
    const silent = words === 0 && now - mode.speaking.at > 8000
    if ((words > 0 && !session.relay.talking()) || silent) set({ speaking: undefined })
    else if (words !== mode.speaking.words) set({ speaking: { ...mode.speaking, words } })
  }
  // A forwarded request still unanswered: a short spoken "still on it", first after 20 s, then every 45 s.
  if (asked !== undefined && now - asked >= (nudged ? 45_000 : 20_000)) {
    asked = now
    nudged = true
    try {
      session.speak('Still on it.')
    } catch (error) {
      set({ problem: describe(error) })
    }
  }
  if (session.relay.idleFor(now) >= IDLE_MS) release('paused')
}
/** Often enough that the words on screen follow speech; the relay itself joins lines every 100 ms. */
const TICK_MS = 150

/** When the open forwarded request went out (or was last nudged about), until its answer is heard. */
let asked: number | undefined
let nudged = false

function onEvent(event: LiveEvent) {
  if (event.type === 'session.closed' && session && mode.phase === 'live')
    set({
      problem: event.reason ? `Session closed: ${event.reason}` : 'The session closed',
    })
}

/** Start a session, from a user gesture or for an answer that arrived while paused. Never two at once. */
export async function open(speech?: string, entry?: number): Promise<void> {
  if (speech) queued.push({ text: speech, entry })
  if (mode.phase === 'starting' || mode.phase === 'live' || mode.phase === 'ending') return
  const from = mode.phase
  cancelled = false
  set({
    phase: 'starting',
    problem: undefined,
    waiting: undefined,
    ...(from === 'off' ? { front: true } : {}),
  })
  // Awaiting nothing would still yield, and Safari wants getUserMedia within the tap.
  if (closing) await closing
  let started: LiveSession
  try {
    started = await startLive({
      // api.action's rest arguments do not take a generic A; the ref still names the real args.
      action: <A, R>(ref: ActionRef<A, R>, args: A) =>
        api.action(ref as ActionRef<null, R>, args as null),
      onEvent,
      onError: (error) => set({ problem: describe(error) }),
    })
  } catch (error) {
    const waiting = queued.at(-1)?.text
    queued = []
    if (cancelled) return set({ phase: 'off', problem: undefined, front: false })
    // An answer that could not wake the session waits for a tap; a failed first start leaves voice mode.
    return set(
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
  ticker = setInterval(tick, TICK_MS)
  set({ phase: 'live', since: Date.now() })
  try {
    if (mode.muted) started.mute()
    for (const item of queued) say(started, item.text, item.entry)
  } catch (error) {
    set({ problem: describe(error) })
  }
  queued = []
}

/** Driven by open forwarded lines, not an acknowledgement or small-talk say. */
export function working(pending: boolean) {
  if (pending && asked === undefined) {
    asked = Date.now()
    nudged = false
  } else if (!pending) asked = undefined
}

/** Quiet context is only useful to the current live session. */
export function note(text: string) {
  if (!session) return
  try {
    session.send({
      type: 'session.thinking.append',
      event_id: crypto.randomUUID(),
      content: text,
    })
  } catch (error) {
    set({ problem: describe(error) })
  }
}

/** Read a line out, following it word by word when it is a Voice line on screen. */
function say(live: LiveSession, text: string, entry?: number) {
  live.speak(text)
  set({ speaking: entry === undefined ? undefined : { entry, words: 0, at: Date.now() } })
}

/** An answer to speak: now while live, after the start in flight, or by waking a paused session. */
export function hear(text: string, entry?: number) {
  if (mode.phase === 'live' && session) {
    try {
      say(session, text, entry)
    } catch (error) {
      set({ problem: describe(error) })
    }
  } else if (mode.phase === 'starting') queued.push({ text, entry })
  else if (mode.phase === 'paused') {
    // Without an earlier gesture on this page the browser keeps the microphone and audio shut: ask for a tap.
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) set({ waiting: text })
    // oxlint-disable-next-line typescript/no-floating-promises -- open never rejects: its failures become `problem`.
    else void open(text, entry)
  }
}

export function setMuted(muted: boolean) {
  try {
    if (session) {
      if (muted) session.mute()
      else session.unmute()
    }
    set({ muted })
  } catch (error) {
    set({ problem: describe(error) })
  }
}

/** Leave voice mode: close the session, or cancel the one starting. */
export function end() {
  if (mode.phase === 'off') return
  queued = []
  if (mode.phase === 'starting') {
    cancelled = true
    return set({ phase: 'ending' })
  }
  release('off')
  set({ problem: undefined, waiting: undefined, muted: false, front: false })
}

// A session never outlives its page.
addEventListener('pagehide', () => {
  stopHum()
  if (session) release('off')
})
