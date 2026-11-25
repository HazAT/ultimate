import type { ConversationId } from '@earendil-works/pi-durable'
import { api, errorMessage } from '@/sdk/solid'
import { PrepareAction } from './refs.ts'
import { splitReply } from './speech.ts'
import { speech } from './voice.solid.tsx'

export type Reading = {
  conversation: ConversationId
  entry: number
  status: 'loading' | 'playing' | 'paused'
  error?: string
}

type Source = { key: string; conversation: ConversationId; entry: number; text: string }

let source: Source | undefined
const listeners = new Set<() => void>()
const changed = () => {
  for (const listener of listeners) listener()
  if ('mediaSession' in navigator)
    navigator.mediaSession.playbackState = !current()
      ? 'none'
      : current()!.status === 'paused'
        ? 'paused'
        : 'playing'
}
speech.state.subscribe(changed)
speech.failure.subscribe(changed)

export const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function current(): Reading | undefined {
  if (!source) return undefined
  const { conversation, entry } = source
  const failure = speech.failure.get()
  if (failure?.key === source.key)
    return { conversation, entry, status: 'paused', error: failure.message }
  const now = speech.state.get()
  if (now.key !== source.key || !(now.playing || now.paused || now.streaming)) return undefined
  return {
    conversation,
    entry,
    status: now.playing ? 'playing' : now.paused ? 'paused' : 'loading',
  }
}

export function read(conversation: ConversationId, entry: number, text: string) {
  source = { key: `read-aloud:${conversation}/${entry}`, conversation, entry, text }
  speech.warm()
  speech.load(source.key, [], true)
  setUpMediaSession()
  void prepare(source.key, text)
}

async function prepare(key: string, text: string) {
  const ours = () => speech.state.get().key === key
  const parts: { text: string; final: boolean }[] = []
  let pushed = 0
  try {
    for (let section = 0, sections = 1; section < sections && ours(); section++) {
      const prepared = await api.action(PrepareAction, { text, section })
      sections = prepared.sections
      if (!ours()) return
      parts.push({ text: prepared.spoken, final: true })
      const { sentences } = splitReply(parts)
      for (const sentence of sentences.slice(pushed)) speech.push(key, sentence)
      pushed = sentences.length
    }
    if (ours()) speech.streaming(false)
  } catch (error) {
    if (!ours()) return
    speech.stop()
    speech.failure.set({ key, message: errorMessage(error) })
  }
}

export const pause = () => void speech.pause()

export function resume() {
  const reading = current()
  if (reading?.error && source) read(source.conversation, source.entry, source.text)
  else speech.resume()
}

export function stop() {
  if (current()) speech.stop()
  source = undefined
  changed()
}

function setUpMediaSession() {
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.metadata = new MediaMetadata({ title: 'Read aloud', artist: 'Ultimate' })
  navigator.mediaSession.setActionHandler('play', resume)
  navigator.mediaSession.setActionHandler('pause', pause)
  navigator.mediaSession.setActionHandler('stop', stop)
}
