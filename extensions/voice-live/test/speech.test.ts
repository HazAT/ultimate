import { expect, it } from 'vitest'
import { createPlayer, fetchedVoice, splitReply } from '../speech.ts'
import type { AudioLike } from '../speech.ts'

function fakeVoice() {
  const requests: { text: string; signal: AbortSignal; resolve: (src: string) => void }[] = []
  const clips: (AudioLike & { listeners: Map<string, () => void>; paused: boolean })[] = []
  const failures: unknown[] = []
  const engine = fetchedVoice({
    load: (text, signal) =>
      new Promise((resolve, reject) => {
        requests.push({ text, signal, resolve })
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    audio: () => {
      const listeners = new Map<string, () => void>()
      const clip = {
        src: '',
        playbackRate: 1,
        duration: 2,
        paused: true,
        listeners,
        play: async () => {
          clip.paused = false
          listeners.get('playing')?.()
        },
        pause: () => (clip.paused = true),
        addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      }
      clips.push(clip)
      return clip
    },
    failed: (error) => failures.push(error),
  })
  const player = createPlayer({
    rate: () => 1.25,
    enabled: () => true,
    listening: () => false,
    frame: () => () => {},
    engine: () => engine,
  })
  const request = (text: string) => requests.find((item) => item.text === text)!
  return { player, requests, request, clips, failures }
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))

it('reads a streaming reply sentence by sentence, fetching the next one while the current plays', async () => {
  const { player, requests, request, clips } = fakeVoice()
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
  expect(clips.map((clip) => [clip.src, clip.playbackRate])).toEqual([['data:first', 1.25]])
  expect(player.state.get()).toMatchObject({ index: 0, playing: true })

  request(' Second one.').resolve('data:second')
  const third = splitReply([{ text: 'First one. Second one. Third.', final: true }]).sentences[2]
  player.push('turn', third)
  clips[0].listeners.get('ended')!()
  await flush()
  await flush()
  await flush()
  expect(clips.map((clip) => clip.src)).toEqual(['data:first', 'data:second'])
  expect(requests.map((item) => item.text)).toEqual(['First one.', ' Second one.', ' Third.'])
  expect(requests.filter((item) => item.signal.aborted)).toEqual([])
})

it('a long sentence starts with its first clause while the rest is still being read', async () => {
  const { player, requests, request, clips } = fakeVoice()
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
  expect(clips.map((clip) => clip.src)).toEqual(['data:first'])
  expect(requests.map((item) => item.text)).toEqual([
    'Your starter is ready when it doubles within a few hours of feeding,',
    ' smells pleasantly tangy and shows bubbles all through the jar.',
  ])
  request(' smells pleasantly tangy and shows bubbles all through the jar.').resolve('data:rest')
  clips[0].listeners.get('ended')!()
  await flush()
  await flush()
  expect(clips.map((clip) => clip.src)).toEqual(['data:first', 'data:rest'])
  expect(player.state.get()).toMatchObject({ index: 0, playing: true })
  clips[1].listeners.get('ended')!()
  await flush()
  await flush()
  expect(player.state.get()).toMatchObject({ playing: false })
})

it('cutting in stops playback at once and aborts the queued and prefetching requests', async () => {
  const { player, requests, request, clips, failures } = fakeVoice()
  player.load('turn', [], true)
  for (const sentence of splitReply([{ text: 'One. Two. Three. ', final: false }]).sentences)
    player.push('turn', sentence)
  await flush()
  request('One.').resolve('data:one')
  await flush()
  await flush()
  expect(clips[0].paused).toBe(false)
  expect(requests.map((item) => item.text)).toEqual(['One.', ' Two.'])

  player.stop()
  expect(clips[0].paused).toBe(true)
  expect(request(' Two.').signal.aborted).toBe(true)
  expect(player.state.get()).toMatchObject({ playing: false, paused: false })

  request(' Two.').resolve('data:late')
  clips[0].listeners.get('ended')!()
  await flush()
  expect(clips).toHaveLength(1)
  expect(requests).toHaveLength(2)
  expect(failures).toEqual([])
})
