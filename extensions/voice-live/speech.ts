import { cell } from '../../lib/cell.ts'
import { inProcess, overshadowed } from '../../lib/errors.ts'
import { MAX_SPOKEN } from './voices.ts'

export const CHARS_PER_SECOND = 14.5

export type Sentence = { text: string; paragraph: number; starts: number[]; words: string[] }

export type PlayerState = {
  key?: string
  index: number
  charIndex: number
  playing: boolean
  paused: boolean
  streaming: boolean
  startedAt: number
}

const measured = new Map<number, number>()
const rateKey = (rate: number) => Math.round(rate * 20) / 20

export const charsPerSecond = (rate: number) =>
  measured.get(rateKey(rate)) ?? CHARS_PER_SECOND * rate

function learn(rate: number, chars: number, seconds: number) {
  if (seconds < 0.8 || chars < 12) return
  const sample = chars / seconds
  const known = measured.get(rateKey(rate))
  measured.set(rateKey(rate), known === undefined ? sample : known * 0.6 + sample * 0.4)
}

export const estimate = (text: string, rate: number) => text.length / charsPerSecond(rate)

export function splitReply(parts: readonly { text: string; final: boolean }[]) {
  const sentences: Sentence[] = []
  let pending = ''
  let paragraph = 0
  for (const part of parts) {
    if (!part.text.trim()) continue
    const split = splitSentences(part.text, part.final)
    if (sentences.length) paragraph++
    for (const sentence of split.sentences)
      sentences.push({ ...sentence, paragraph: paragraph + sentence.paragraph })
    paragraph += split.sentences.at(-1)?.paragraph ?? 0
    pending = split.pending
  }
  return { sentences, pending }
}

export function splitSentences(text: string, final: boolean) {
  const sentences: Sentence[] = []
  let rest = text
  let paragraph = 0
  for (;;) {
    const boundary = rest.search(/[.!?]\s/) + 1
    const cut = boundary > 0 ? boundary : final && rest.trim() ? rest.length : 0
    if (cut <= 0) break
    const sentence = rest.slice(0, cut)
    if (/^\s*\n\s*\n/.test(sentence) && sentences.length) paragraph++
    const starts = [...sentence.matchAll(/\S+/g)].map((match) => match.index)
    sentences.push({
      text: sentence,
      paragraph,
      starts,
      words: starts.map((start) => /^\S+/.exec(sentence.slice(start))![0]),
    })
    rest = rest.slice(cut)
  }
  return { sentences, pending: rest }
}

export type SpeechEvents = {
  start: (seconds?: number) => void
  boundary: (charIndex: number) => void
  end: () => void
}

export type SpeechEngine = {
  say: (text: string, rate: number, events: SpeechEvents) => void
  prefetch?: (text: string) => void
  halt: () => void
  reset: () => void
}

export const systemVoices = () => {
  const synth = globalThis.speechSynthesis as SpeechSynthesis | undefined
  return {
    some: () => !!synth?.getVoices().length,
    subscribe: (listener: () => void) => synth?.addEventListener('voiceschanged', listener),
  }
}

export const systemVoice = (): SpeechEngine => ({
  say(text, rate, events) {
    if (!('speechSynthesis' in globalThis)) return events.end()
    speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = rate
    utterance.addEventListener('start', () => events.start())
    utterance.addEventListener('boundary', (event) => {
      if (!event.name || event.name === 'word') events.boundary(event.charIndex)
    })
    utterance.addEventListener('end', events.end)
    utterance.addEventListener('error', events.end)
    speechSynthesis.speak(utterance)
  },
  halt: () => globalThis.speechSynthesis?.cancel(),
  reset: () => globalThis.speechSynthesis?.cancel(),
})

export type AudioLike = {
  src: string
  playbackRate: number
  readonly duration: number
  play: () => Promise<void>
  pause: () => void
  addEventListener: (type: 'playing' | 'ended' | 'error', listener: () => void) => void
}

export function clauses(text: string) {
  const parts: string[] = []
  let rest = text
  for (;;) {
    const least = parts.length ? 40 : 20
    const cut = [...rest.matchAll(/[,;:—]\s/g)].find(
      (match) => match.index >= least && rest.length - match.index > 40,
    )
    if (!cut) break
    parts.push(rest.slice(0, cut.index + 1))
    rest = rest.slice(cut.index + 1)
  }
  return [...parts, rest].flatMap(atMost)
}

function atMost(text: string) {
  const parts: string[] = []
  let rest = text
  while (rest.length > MAX_SPOKEN) {
    const space = rest.slice(0, MAX_SPOKEN).search(/\s\S*$/)
    const cut = space >= 0 ? space + 1 : MAX_SPOKEN
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  return [...parts, rest].filter((part) => part.trim())
}

export function fetchedVoice(options: {
  load: (text: string, signal: AbortSignal) => Promise<string>
  audio: () => AudioLike
  failed: (error: unknown) => void
}): SpeechEngine {
  const fetched = new Map<string, { controller: AbortController; parts: Promise<string>[] }>()
  let playing: AudioLike | undefined
  let turn = 0
  const request = (text: string) => {
    const known = fetched.get(text)
    if (known) return known.parts
    const controller = new AbortController()
    const parts: Promise<string>[] = []
    for (const part of clauses(text))
      parts.push(
        (parts.at(-1) ?? Promise.resolve('')).then(() => options.load(part, controller.signal)),
      )
    for (const part of parts)
      inProcess('speech fetched for this open page only', part.catch(overshadowed))
    fetched.set(text, { controller, parts })
    return parts
  }
  const drop = (text: string) => {
    const known = fetched.get(text)
    if (!known) return
    fetched.delete(text)
    known.controller.abort()
  }
  const halt = () => {
    turn++
    playing?.pause()
    playing = undefined
  }
  const clip = (src: string, rate: number, started: (audio: AudioLike) => void) =>
    new Promise<void>((resolve, reject) => {
      const audio = (playing = options.audio())
      audio.src = src
      audio.playbackRate = rate
      audio.addEventListener('playing', () => started(audio))
      audio.addEventListener('ended', resolve)
      audio.addEventListener('error', () => reject(new Error('The audio could not play')))
      inProcess('audio plays on this open page only', audio.play().catch(reject))
    })
  async function play(text: string, rate: number, events: SpeechEvents, mine: number) {
    const parts = request(text)
    const first = clauses(text)[0]
    try {
      for (const [at, part] of parts.entries()) {
        const src = await part
        if (mine !== turn) return
        await clip(src, rate, (audio) => {
          if (at === 0 && mine === turn)
            events.start(((audio.duration / rate) * text.length) / first.length)
        })
        if (mine !== turn) return
      }
      if (fetched.get(text)?.parts === parts) fetched.delete(text)
      events.end()
    } catch (error) {
      if (fetched.get(text)?.parts === parts) drop(text)
      if (mine !== turn) return
      options.failed(error)
      events.end()
    }
  }
  return {
    say(text, rate, events) {
      halt()
      for (const other of fetched.keys()) if (other !== text) drop(other)
      inProcess('a sentence plays only on this open page', play(text, rate, events, turn))
    },
    prefetch: (text) => void request(text),
    halt,
    reset() {
      halt()
      for (const text of fetched.keys()) drop(text)
    },
  }
}

export function createPlayer(options: {
  rate: () => number
  enabled: () => boolean
  listening: () => boolean
  frame: (fn: () => void) => () => void
  engine: () => SpeechEngine
}) {
  let engine = options.engine()
  let items: Sentence[] = []
  const state = cell<PlayerState>({
    index: -1,
    charIndex: -1,
    playing: false,
    paused: false,
    streaming: false,
    startedAt: 0,
  })
  let token = 0
  let stopWordClock: (() => void) | undefined
  const idle = new Set<() => void>()
  const publish = (change: Partial<PlayerState>) => {
    state.set({ ...state.get(), ...change })
    const now = state.get()
    if (now.playing || now.paused || now.streaming) return
    const waiting = [...idle]
    idle.clear()
    for (const done of waiting) done()
  }

  function play(index: number) {
    const item = items[index]
    if (!item) return
    if (options.listening()) {
      engine.halt()
      publish({ index, charIndex: -1, playing: false, paused: true })
      return
    }
    const mine = ++token
    pick()
    engine.halt()
    stopWordClock?.()
    let boundaries = false
    let audible: number | undefined
    const rate = options.rate()
    const startedAt = Date.now()
    const show = (at: number) => {
      const charIndex = item.starts.findLast((start) => start <= at) ?? 0
      if (charIndex > state.get().charIndex) publish({ charIndex })
    }
    const start = (seconds?: number) => {
      if (mine !== token) return
      audible = Date.now()
      const speed =
        seconds && Number.isFinite(seconds) ? item.text.length / seconds : charsPerSecond(rate)
      stopWordClock = options.frame(() => {
        if (boundaries || mine !== token || audible === undefined) return
        show(((Date.now() - audible) / 1000) * speed)
      })
    }
    const boundary = (charIndex: number) => {
      boundaries = true
      if (mine === token) show(charIndex)
    }
    const finished = () => {
      if (mine !== token) return
      stopWordClock?.()
      if (audible !== undefined) learn(rate, item.text.length, (Date.now() - audible) / 1000)
      if (items[index + 1]) play(index + 1)
      else publish({ playing: false, charIndex: -1 })
    }
    publish({ index, charIndex: -1, playing: true, paused: false, startedAt })
    engine.say(item.text, rate, { start, boundary, end: finished })
    prefetchNext()
  }

  function pick() {
    const picked = options.engine()
    if (picked === engine) return
    engine.reset()
    engine = picked
  }

  const prefetchNext = () => {
    const next = items[state.get().index + 1]
    if (next && state.get().playing && options.engine() === engine) engine.prefetch?.(next.text)
  }

  const halt = () => {
    token++
    engine.halt()
    stopWordClock?.()
  }
  const drop = () => {
    halt()
    engine.reset()
  }

  return {
    state,
    items: () => items as readonly Sentence[],
    load(key: string, sentences: readonly Sentence[], streaming: boolean) {
      drop()
      items = [...sentences]
      publish({ key, index: -1, charIndex: -1, playing: false, paused: false, streaming })
    },
    push(key: string, sentence: Sentence) {
      if (!options.enabled() || state.get().key !== key) return
      items.push(sentence)
      const now = state.get()
      if (!now.playing && !now.paused) play(items.length - 1)
      else prefetchNext()
    },
    play,
    switched() {
      const now = state.get()
      if (now.playing) play(Math.max(0, now.index))
      else pick()
    },
    streaming(on: boolean) {
      publish({ streaming: on })
    },
    pause() {
      if (!state.get().playing) return false
      halt()
      publish({ playing: false, paused: true })
      return true
    },
    resume() {
      const now = state.get()
      if (now.paused) play(Math.max(0, now.index))
    },
    toggle() {
      const now = state.get()
      if (now.playing) this.pause()
      else if (items.length) play(now.paused ? Math.max(0, now.index) : 0)
    },
    stop() {
      drop()
      publish({ playing: false, paused: false, streaming: false, charIndex: -1 })
    },
    sentence(step: number) {
      if (items.length) play(Math.min(items.length - 1, Math.max(0, state.get().index + step)))
    },
    paragraph(step: number) {
      if (!items.length) return
      const now = state.get()
      const starts = items.flatMap((item, at) =>
        at === 0 || items[at - 1].paragraph !== item.paragraph ? [at] : [],
      )
      const mine = starts.findLast((at) => at <= now.index) ?? 0
      if (step > 0) {
        const next = starts.find((at) => at > now.index)
        if (next === undefined) this.stop()
        else play(next)
        return
      }
      const intoIt = now.index > mine || Date.now() - now.startedAt > 1500
      play(intoIt && now.playing ? mine : (starts.findLast((at) => at < mine) ?? mine))
    },
    idle() {
      const now = state.get()
      if (!now.playing && !now.paused && !now.streaming) return Promise.resolve()
      return new Promise<void>((resolve) => idle.add(resolve))
    },
  }
}

export type Player = ReturnType<typeof createPlayer>
