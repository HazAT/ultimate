/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { api, errorMessage } from '@/sdk/solid'
import { meansNone } from '../../lib/errors.ts'
import { SpeakAction } from './refs.ts'
import type { SpokenSection } from './refs.ts'

export type Reading = {
  conversation: ConversationId
  entry: number
  text: string
  section: number
  sections?: number
  spoken?: string
  status: 'loading' | 'playing' | 'paused'
  error?: string
}

let reading: Reading | undefined
const listeners = new Set<() => void>()
let audio: HTMLAudioElement | undefined
let utterance: SpeechSynthesisUtterance | undefined
let fetching = new AbortController()
let fetched = new Map<number, Promise<SpokenSection>>()
let rate = 1

export function setRate(next: number) {
  rate = next
  if (audio) audio.playbackRate = next
}

const set = (next: Reading | undefined) => {
  reading = next
  for (const listener of listeners) listener()
  if ('mediaSession' in navigator)
    navigator.mediaSession.playbackState = !next
      ? 'none'
      : next.status === 'paused'
        ? 'paused'
        : 'playing'
}

export const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export const current = () => reading

function section(text: string, index: number) {
  const known = fetched.get(index)
  if (known) return known
  const request = api.action(SpeakAction, { text, section: index }, { signal: fetching.signal })
  fetched.set(index, request)
  return request
}

function release() {
  fetching.abort()
  fetching = new AbortController()
  fetched = new Map()
  if (audio) {
    audio.pause()
    URL.revokeObjectURL(audio.src)
    audio = undefined
  }
  if (utterance) {
    utterance = undefined
    speechSynthesis.cancel()
  }
}

export function stop() {
  release()
  set(undefined)
}

export function read(conversation: ConversationId, entry: number, text: string) {
  release()
  set({ conversation, entry, text, section: 0, status: 'loading' })
  setUpMediaSession()
  void play(text, 0)
}

async function play(text: string, index: number) {
  const mine = (): Reading | undefined =>
    reading?.text === text && reading.section === index ? reading : undefined
  const failed = (error: unknown) => {
    const now = mine()
    if (now) set({ ...now, status: 'paused', error: errorMessage(error) })
  }
  let spoken: SpokenSection
  try {
    spoken = await section(text, index)
  } catch (error) {
    return failed(error)
  }
  const now = mine()
  if (!now) return
  if (index + 1 < spoken.sections) section(text, index + 1).catch(meansNone)
  set({ ...now, sections: spoken.sections, spoken: spoken.spoken, status: 'playing' })
  const next = () => {
    const still = mine()
    if (!still) return
    if (index + 1 >= spoken.sections) return stop()
    set({ ...still, section: index + 1, spoken: undefined, status: 'loading' })
    void play(text, index + 1)
  }
  if (spoken.audio) {
    const bytes = Uint8Array.from(atob(spoken.audio), (c) => c.charCodeAt(0))
    const player = new Audio(URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' })))
    audio = player
    player.playbackRate = rate
    player.addEventListener('ended', () => audio === player && next())
    await player.play().catch(failed)
  } else {
    const line = new SpeechSynthesisUtterance(spoken.spoken)
    utterance = line
    line.rate = rate
    line.addEventListener('end', () => utterance === line && next())
    speechSynthesis.speak(line)
  }
}

export function pause() {
  if (reading?.status !== 'playing') return
  if (audio) audio.pause()
  else speechSynthesis.pause()
  set({ ...reading, status: 'paused' })
}

export function resume() {
  if (reading?.status !== 'paused') return
  if (reading.error) {
    const { text, section: index } = reading
    release()
    set({ ...reading, error: undefined, status: 'loading' })
    void play(text, index)
    return
  }
  if (audio) void audio.play()
  else speechSynthesis.resume()
  set({ ...reading, status: 'playing' })
}

function setUpMediaSession() {
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.metadata = new MediaMetadata({ title: 'Read aloud', artist: 'Ultimate' })
  navigator.mediaSession.setActionHandler('play', resume)
  navigator.mediaSession.setActionHandler('pause', pause)
  navigator.mediaSession.setActionHandler('stop', stop)
}
