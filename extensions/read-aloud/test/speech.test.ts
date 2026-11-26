import { expect, it } from 'vitest'
import { clauses, createPlayer, fetchedVoice, splitReply } from '../speech.ts'
import { until } from '../../../test/helpers.ts'

function fakeVoice(options: { refuse?: () => Error | undefined } = {}) {
  let selected: 'openai' | 'system' = 'openai'
  const spoken: string[] = []
  const system = {
    say: (text: string) => spoken.push(text),
    halt: () => {},
    reset: () => {},
  }
  const requests: { text: string; signal: AbortSignal; resolve: (src: string) => void }[] = []
  const listeners = new Map<string, () => void>()
  const audio = {
    src: '',
    playbackRate: 1,
    duration: 2,
    paused: true,
    played: [] as [string, number][],
    play: async () => {
      const refused = options.refuse?.()
      if (refused) throw refused
      audio.paused = false
      audio.played.push([audio.src, audio.playbackRate])
      listeners.get('playing')?.()
    },
    pause: () => (audio.paused = true),
    end: () => {
      audio.paused = true
      listeners.get('ended')?.()
    },
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
  }
  const failures: unknown[] = []
  const engine = fetchedVoice({
    load: (text, signal) =>
      new Promise((resolve, reject) => {
        requests.push({ text, signal, resolve })
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    audio,
    failed: (error) => {
      failures.push(error)
      player.stop()
    },
  })
  const player = createPlayer({
    rate: () => 1.25,
    enabled: () => true,
    listening: () => false,
    frame: () => () => {},
    engine: () => (selected === 'openai' ? engine : system),
  })
  const request = (text: string) => requests.find((item) => item.text === text)!
  const select = (to: 'openai' | 'system') => {
    selected = to
    player.switched()
  }
  return { player, engine, requests, request, audio, failures, select, spoken }
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))

it('reads a streaming reply sentence by sentence, fetching the next one while the current plays', async () => {
  const { player, requests, request, audio } = fakeVoice()
  player.load('turn', [], true)
  const streamed = splitReply([{ text: 'First one. Second one. Third', final: false }])
  expect(streamed.sentences.map((sentence) => sentence.text)).toEqual([
    'First one.',
    ' Second one.',
  ])
  expect(streamed.pending).toBe(' Third')

  player.push('turn', streamed.sentences[0])
  player.push('turn', streamed.sentences[1])
  await flush()
  expect(requests.map((item) => item.text)).toEqual(['First one.', ' Second one.'])

  request('First one.').resolve('data:first')
  await flush()
  await flush()
  expect(audio.played).toEqual([['data:first', 1.25]])
  expect(player.state.get()).toMatchObject({ index: 0, playing: true })

  request(' Second one.').resolve('data:second')
  const third = splitReply([{ text: 'First one. Second one. Third.', final: true }]).sentences[2]
  player.push('turn', third)
  audio.end()
  await flush()
  await flush()
  await flush()
  expect(audio.played.map(([src]) => src)).toEqual(['data:first', 'data:second'])
  expect(requests.map((item) => item.text)).toEqual(['First one.', ' Second one.', ' Third.'])
  expect(requests.filter((item) => item.signal.aborted)).toEqual([])
})

it('a long sentence starts with its first clause while the rest is still being read', async () => {
  const { player, requests, request, audio } = fakeVoice()
  const long =
    'Your starter is ready when it doubles within a few hours of feeding, smells pleasantly tangy and shows bubbles all through the jar. '
  player.load('turn', splitReply([{ text: long, final: true }]).sentences, false)
  player.play(0)
  await flush()
  expect(requests.map((item) => item.text)).toEqual([
    'Your starter is ready when it doubles within a few hours of feeding,',
  ])
  requests[0].resolve('data:first')
  await flush()
  await flush()
  expect(audio.played.map(([src]) => src)).toEqual(['data:first'])
  expect(requests.map((item) => item.text)).toEqual([
    'Your starter is ready when it doubles within a few hours of feeding,',
    ' smells pleasantly tangy and shows bubbles all through the jar.',
  ])
  request(' smells pleasantly tangy and shows bubbles all through the jar.').resolve('data:rest')
  audio.end()
  await flush()
  await flush()
  expect(audio.played.map(([src]) => src)).toEqual(['data:first', 'data:rest'])
  expect(player.state.get()).toMatchObject({ index: 0, playing: true })
  audio.end()
  await flush()
  await flush()
  expect(player.state.get()).toMatchObject({ playing: false })
})

it('cutting in stops playback at once and aborts the queued and prefetching requests', async () => {
  const { player, requests, request, audio, failures } = fakeVoice()
  player.load('turn', [], true)
  for (const sentence of splitReply([{ text: 'One. Two. Three. ', final: false }]).sentences)
    player.push('turn', sentence)
  await flush()
  request('One.').resolve('data:one')
  await flush()
  await flush()
  expect(audio.paused).toBe(false)
  expect(requests.map((item) => item.text)).toEqual(['One.', ' Two.'])

  player.stop()
  expect(audio.paused).toBe(true)
  expect(request(' Two.').signal.aborted).toBe(true)
  expect(player.state.get()).toMatchObject({ playing: false, paused: false })

  request(' Two.').resolve('data:late')
  audio.end()
  await flush()
  expect(audio.played).toHaveLength(1)
  expect(requests).toHaveLength(2)
  expect(failures).toEqual([])
})

it('a clip that cannot play stops the reply and aborts the clauses and sentence still being read', async () => {
  const { player, requests, failures } = fakeVoice({
    refuse: () => new Error('The audio could not play'),
  })
  const reply =
    'Your starter is ready when it doubles within a few hours of feeding, smells pleasantly tangy and shows bubbles all through the jar. Then bake. '
  player.load('turn', splitReply([{ text: reply, final: true }]).sentences, false)
  player.play(0)
  await until(() => requests.length === 2)
  requests[0].resolve('data:first')
  await until(() => failures.length === 1)
  expect(requests.map((item) => [item.text, item.signal.aborted])).toEqual([
    ['Your starter is ready when it doubles within a few hours of feeding,', true],
    [' Then bake.', true],
    [' smells pleasantly tangy and shows bubbles all through the jar.', true],
  ])
  expect(player.state.get()).toMatchObject({ playing: false })
})

it('a play the browser refuses before a tap waits paused and blocked, and ▶ plays that sentence', async () => {
  let gesture = false
  const { player, request, audio, failures } = fakeVoice({
    refuse: () => (gesture ? undefined : new DOMException('Needs a gesture', 'NotAllowedError')),
  })
  player.load('turn', splitReply([{ text: 'One. Two.', final: true }]).sentences, false)
  player.play(0)
  await flush()
  request('One.').resolve('data:one')
  await until(() => player.state.get().blocked)
  expect(player.state.get()).toMatchObject({ index: 0, playing: false, paused: true })
  expect(failures).toEqual([])
  gesture = true
  player.resume()
  await until(() => audio.played.length === 1)
  expect(player.state.get()).toMatchObject({ index: 0, playing: true, blocked: false })
})

it('a refusal from a sentence that was cut off never pauses the one playing now', () => {
  const refusals: (() => void)[] = []
  const player = createPlayer({
    rate: () => 1,
    enabled: () => true,
    listening: () => false,
    frame: () => () => {},
    engine: () => ({
      say: (_text, _rate, events) => void refusals.push(events.blocked),
      halt() {},
      reset() {},
    }),
  })
  player.load('a', splitReply([{ text: 'One.', final: true }]).sentences, false)
  player.play(0)
  player.load('b', splitReply([{ text: 'Two.', final: true }]).sentences, false)
  player.play(0)
  refusals[0]()
  expect(player.state.get()).toMatchObject({ key: 'b', playing: true, blocked: false })
})

it('a tap unlocks the one audio element that later sentences play through, without cutting off a clip', async () => {
  const { player, engine, request, audio } = fakeVoice()
  engine.unlock!()
  expect(audio.played).toEqual([[expect.stringMatching(/^data:audio\/wav;base64,/), 1]])
  audio.end()
  player.load('turn', [], true)
  for (const sentence of splitReply([{ text: 'One. Two. ', final: false }]).sentences)
    player.push('turn', sentence)
  await flush()
  request('One.').resolve('data:one')
  await until(() => audio.played.length === 2)
  engine.unlock!()
  expect(audio.src).toBe('data:one')
  request(' Two.').resolve('data:two')
  audio.end()
  await until(() => audio.played.length === 3)
  expect(audio.played.map(([src]) => src).slice(1)).toEqual(['data:one', 'data:two'])
})

it('switching to the system voice stops OpenAI work and reads new sentences with the system voice', async () => {
  const { player, requests, audio, select, spoken } = fakeVoice()
  player.load('turn', [], true)
  for (const sentence of splitReply([{ text: 'One. Two. ', final: false }]).sentences)
    player.push('turn', sentence)
  await until(() => requests.length === 2)
  requests[0].resolve('data:one')
  await until(() => audio.played.length === 1)
  select('system')
  expect(audio.paused).toBe(true)
  expect(requests.every((item) => item.signal.aborted)).toBe(true)
  expect(spoken).toEqual(['One.'])
  player.push('turn', splitReply([{ text: 'One. Two. Three. ', final: false }]).sentences[2])
  expect(requests).toHaveLength(2)
})

it('a clause longer than one request allows is split at a word boundary', () => {
  const long = `${'word '.repeat(500)}end.`
  const parts = clauses(long)
  expect(parts.every((part) => part.length <= 2000)).toBe(true)
  expect(parts.join('')).toBe(long)
  expect(parts[0].endsWith('word ')).toBe(true)
  expect(clauses(`${'a'.repeat(1999)}\t${'b'.repeat(2000)}`)).toEqual([
    `${'a'.repeat(1999)}\t`,
    'b'.repeat(2000),
  ])
  const tabbed = clauses(`${' '.repeat(2001)}${'tab\t'.repeat(600)}end.`)
  expect(tabbed.every((part) => part.trim() && part.length <= 2000)).toBe(true)
  expect(
    tabbed.every((part) => !/\S$/.test(part) || part.endsWith('end.') || part.endsWith('tab')),
  ).toBe(true)
})

it('reloading the reply that plays to seek in it keeps its idle waiter until the new place has played', async () => {
  const ends: (() => void)[] = []
  const player = createPlayer({
    rate: () => 1,
    enabled: () => true,
    listening: () => false,
    frame: () => () => {},
    engine: () => ({
      say: (_text, _rate, events) => void ends.push(events.end),
      halt() {},
      reset() {},
    }),
  })
  const sentences = splitReply([{ text: 'One. Two. Three.', final: true }]).sentences
  player.load('turn', [sentences[0], sentences[2]], false)
  player.play(0)
  let idle = false
  const done = player.idle().then(() => {
    idle = true
  })
  player.load('turn', sentences, false)
  player.play(1)
  await Promise.resolve()
  expect(idle).toBe(false)
  ends.at(-1)!()
  ends.at(-1)!()
  await done
})
