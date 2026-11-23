import { cell } from '../../lib/cell.ts'

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

export function createPlayer(options: {
  rate: () => number
  enabled: () => boolean
  listening: () => boolean
  frame: (fn: () => void) => () => void
}) {
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
      speechSynthesis.cancel()
      publish({ index, charIndex: -1, playing: false, paused: true })
      return
    }
    const mine = ++token
    speechSynthesis.cancel()
    stopWordClock?.()
    const utterance = new SpeechSynthesisUtterance(item.text)
    utterance.rate = options.rate()
    let boundaries = false
    let audible: number | undefined
    const rate = utterance.rate
    const startedAt = Date.now()
    const show = (at: number) => {
      const charIndex = item.starts.findLast((start) => start <= at) ?? 0
      if (charIndex > state.get().charIndex) publish({ charIndex })
    }
    utterance.addEventListener('start', () => {
      if (mine !== token) return
      audible = Date.now()
      stopWordClock = options.frame(() => {
        if (boundaries || mine !== token || audible === undefined) return
        show(((Date.now() - audible) / 1000) * charsPerSecond(rate))
      })
    })
    utterance.addEventListener('boundary', (event) => {
      if (event.name && event.name !== 'word') return
      boundaries = true
      if (mine === token) show(event.charIndex)
    })
    const finished = () => {
      if (mine !== token) return
      stopWordClock?.()
      if (audible !== undefined) learn(rate, item.text.length, (Date.now() - audible) / 1000)
      if (items[index + 1]) play(index + 1)
      else publish({ playing: false, charIndex: -1 })
    }
    utterance.addEventListener('end', finished)
    utterance.addEventListener('error', finished)
    publish({ index, charIndex: -1, playing: true, paused: false, startedAt })
    speechSynthesis.speak(utterance)
  }

  const halt = () => {
    token++
    speechSynthesis.cancel()
    stopWordClock?.()
  }

  return {
    state,
    items: () => items as readonly Sentence[],
    load(key: string, sentences: readonly Sentence[], streaming: boolean) {
      halt()
      items = [...sentences]
      publish({ key, index: -1, charIndex: -1, playing: false, paused: false, streaming })
    },
    push(key: string, sentence: Sentence) {
      if (!options.enabled() || state.get().key !== key) return
      items.push(sentence)
      const now = state.get()
      if (!now.playing && !now.paused) play(items.length - 1)
    },
    play,
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
      halt()
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
