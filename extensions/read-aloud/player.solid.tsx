import type { ConversationId } from '@earendil-works/pi-durable'
import { api, errorMessage } from '@/sdk/solid'
import { PrepareAction } from './refs.ts'
import { splitReply } from './speech.web.ts'
import { speech } from './voice.solid.tsx'

export type Reading = {
  key: string
  text: string
  conversation: ConversationId
  entry: number
  status: 'loading' | 'playing' | 'paused'
  blocked?: boolean
  error?: string
}

type Source = {
  key: string
  conversation: ConversationId
  entry: number
  text: string
  preparing: AbortController
  sections: number[]
}

let source: Source | undefined
let attempts = 0
const listeners = new Set<() => void>()
const changed = () => {
  for (const listener of listeners) listener()
  if (!('mediaSession' in navigator)) return
  const reading = current()
  navigator.mediaSession.playbackState = !reading
    ? 'none'
    : reading.status === 'paused'
      ? 'paused'
      : 'playing'
  if (!reading) clearMediaSession()
}
speech.state.subscribe(() => {
  const now = speech.state.get()
  const stopped = !now.playing && !now.paused && !now.streaming
  if (source && (now.key !== source.key || stopped)) source.preparing.abort()
  changed()
})
speech.failure.subscribe(() => {
  if (source && speech.failure.get()?.key === source.key) source.preparing.abort()
  changed()
})

export const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function current(): Reading | undefined {
  if (!source) return undefined
  const { key, text, conversation, entry } = source
  const failure = speech.failure.get()
  if (failure?.key === source.key)
    return { key, text, conversation, entry, status: 'paused', error: failure.message }
  const now = speech.state.get()
  if (now.key !== source.key || !(now.playing || now.paused || now.streaming)) return undefined
  return {
    key,
    text,
    conversation,
    entry,
    status: now.playing ? 'playing' : now.paused ? 'paused' : 'loading',
    blocked: now.blocked,
  }
}

export const sectionOf = (item: number) => source?.sections[item]

export function read(conversation: ConversationId, entry: number, text: string, from = 0) {
  source?.preparing.abort()
  const key = `read-aloud:${conversation}/${entry}:${++attempts}`
  source = { key, conversation, entry, text, preparing: new AbortController(), sections: [] }
  speech.warm()
  speech.load(key, [], true)
  setUpMediaSession()
  void prepare(source, from)
}

export function playSection(
  conversation: ConversationId,
  entry: number,
  text: string,
  section: number,
) {
  const reading = current()
  const ours =
    reading && !reading.error && reading.text === text && reading.entry === entry
      ? reading.conversation === conversation && source
      : undefined
  const item = ours ? ours.sections.indexOf(section) : -1
  if (ours && item >= 0) speech.play(item)
  else read(conversation, entry, text, section)
}

async function prepare({ key, text, preparing, sections: owners }: Source, from: number) {
  const ours = () => !preparing.signal.aborted && speech.state.get().key === key
  const parts: { text: string; final: boolean }[] = []
  let pushed = 0
  try {
    for (let section = from, sections = from + 1; section < sections && ours(); section++) {
      const prepared = await api.action(
        PrepareAction,
        { text, section },
        { signal: preparing.signal },
      )
      sections = prepared.sections
      if (!ours()) return
      parts.push({ text: prepared.spoken, final: true })
      const { sentences } = splitReply(parts)
      for (const sentence of sentences.slice(pushed)) {
        owners.push(section)
        speech.push(key, sentence)
      }
      pushed = sentences.length
    }
    if (ours()) speech.streaming(false)
  } catch (error) {
    if (!ours()) return
    speech.stop()
    speech.failure.set({ key, message: errorMessage(error) })
  }
}

export function pause() {
  if (current()) speech.pause()
}

export function resume() {
  const reading = current()
  if (!reading || !source) return
  if (reading.error) read(source.conversation, source.entry, source.text)
  else speech.resume()
}

export function stop() {
  if (current()) speech.stop()
  source?.preparing.abort()
  source = undefined
  changed()
}

function clearMediaSession() {
  navigator.mediaSession.metadata = null
  for (const action of ['play', 'pause', 'stop'] as const)
    navigator.mediaSession.setActionHandler(action, null)
}

function setUpMediaSession() {
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.metadata = new MediaMetadata({ title: 'Read aloud', artist: 'Ultimate' })
  navigator.mediaSession.setActionHandler('play', resume)
  navigator.mediaSession.setActionHandler('pause', pause)
  navigator.mediaSession.setActionHandler('stop', stop)
}
