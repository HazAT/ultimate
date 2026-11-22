import { cell } from '../../lib/cell.ts'

export const CHARS_PER_SECOND = 14.5

export type Sentence = {
  text: string
  turn: number
  paragraph: number
  onStart: () => void
  onWord: (charIndex: number) => void
  onEnd: () => void
}

export type PlayerState = {
  index: number
  playing: boolean
  paused: boolean
  streaming: boolean
  startedAt: number
  count: number
}

export const estimate = (text: string, rate: number) => text.length / (CHARS_PER_SECOND * rate)

const ticking = (rate: number, startedAt: number) =>
  ((Date.now() - startedAt) / 1000) * CHARS_PER_SECOND * rate

export function createPlayer(options: {
  rate: () => number
  enabled: () => boolean
  frame: (fn: () => void) => () => void
}) {
  const items: Sentence[] = []
  const state = cell<PlayerState>({
    index: -1,
    playing: false,
    paused: false,
    streaming: false,
    startedAt: 0,
    count: 0,
  })
  let token = 0
  let stopWordClock: (() => void) | undefined
  const idle = new Set<() => void>()
  const publish = (change: Partial<PlayerState>) => {
    state.set({ ...state.get(), ...change, count: items.length })
    const now = state.get()
    if (now.playing || now.paused || now.streaming) return
    const waiting = [...idle]
    idle.clear()
    for (const done of waiting) done()
  }

  function play(index: number) {
    const item = items[index]
    if (!item) return
    const mine = ++token
    speechSynthesis.cancel()
    stopWordClock?.()
    const utterance = new SpeechSynthesisUtterance(item.text)
    utterance.rate = options.rate()
    const starts = [...item.text.matchAll(/\S+/g)].map((match) => match.index)
    let boundaries = false
    const startedAt = Date.now()
    stopWordClock = options.frame(() => {
      if (boundaries || mine !== token) return
      const at = ticking(utterance.rate, startedAt)
      item.onWord(starts.findLast((start) => start <= at) ?? 0)
    })
    utterance.addEventListener('boundary', (event) => {
      if (event.name && event.name !== 'word') return
      boundaries = true
      if (mine === token) item.onWord(event.charIndex)
    })
    const finished = () => {
      if (mine !== token) return
      stopWordClock?.()
      item.onEnd()
      if (items[index + 1]) play(index + 1)
      else publish({ playing: false })
    }
    utterance.addEventListener('end', finished)
    utterance.addEventListener('error', finished)
    item.onStart()
    publish({ index, playing: true, paused: false, startedAt })
    speechSynthesis.speak(utterance)
  }

  const halt = () => {
    token++
    speechSynthesis.cancel()
    stopWordClock?.()
    items[state.get().index]?.onEnd()
  }

  return {
    state,
    items: () => items as readonly Sentence[],
    push(item: Sentence) {
      if (!options.enabled()) return
      items.push(item)
      const now = state.get()
      if (!now.playing && !now.paused) play(items.length - 1)
      else publish({})
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
      else if (items.length)
        play(
          now.paused
            ? Math.max(0, now.index)
            : items.findIndex((item) => item.turn === items[Math.max(0, now.index)].turn),
        )
    },
    stop() {
      const wasActive = state.get().playing || state.get().paused
      halt()
      publish({ playing: false, paused: false })
      return wasActive
    },
    clear() {
      halt()
      items.length = 0
      publish({ index: -1, playing: false, paused: false })
    },
    sentence(step: number) {
      if (items.length) play(Math.min(items.length - 1, Math.max(0, state.get().index + step)))
    },
    paragraph(step: number) {
      if (!items.length) return
      const now = state.get()
      const key = (item: Sentence) => `${item.turn}.${item.paragraph}`
      const starts = items.flatMap((item, at) =>
        at === 0 || key(items[at - 1]) !== key(item) ? [at] : [],
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

export function splitSentence(pending: string, final: boolean) {
  if (final) return pending.length
  return pending.search(/[.!?]\s[^]*$/) + 1
}
