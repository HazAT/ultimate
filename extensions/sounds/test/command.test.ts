import { mkdir, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import type { JsonObject } from '@earendil-works/pi-durable'
import * as command from '../command.ts'
import { actions } from '../server.ts'
import type { ActionContext } from '../../../server/actions.ts'
import { apis, createTestExtensionHost, temp } from '../../../test/helpers.ts'
import { ReadAloudApi } from '../../read-aloud/api.ts'
import type { ReadAloudService } from '../../read-aloud/api.ts'

const pcm = Buffer.from([0, 0, 255, 127])
function wav({ sampleRate = 24000, channels = 1 } = {}) {
  const chunk = (name: string, data: Buffer) => {
    const header = Buffer.alloc(8)
    header.write(name)
    header.writeUInt32LE(data.length, 4)
    return Buffer.concat([header, data, Buffer.alloc(data.length % 2)])
  }
  const format = Buffer.alloc(16)
  format.writeUInt16LE(1, 0)
  format.writeUInt16LE(channels, 2)
  format.writeUInt32LE(sampleRate, 4)
  format.writeUInt32LE(sampleRate * channels * 2, 8)
  format.writeUInt16LE(channels * 2, 12)
  format.writeUInt16LE(16, 14)
  const body = Buffer.concat([
    Buffer.from('WAVE'),
    chunk('JUNK', Buffer.from([0])),
    chunk('fmt ', format),
    chunk('data', pcm),
  ])
  return chunk('RIFF', body)
}

afterEach(() => vi.restoreAllMocks())

it('accepts raw PCM or extracts PCM from WAV chunks, including padded unknown chunks', () => {
  expect(command.pcmOf(pcm)).toBe(pcm)
  expect(command.pcmOf(wav())).toEqual(pcm)
})

it.each([{ sampleRate: 22050 }, { channels: 2 }])('rejects unsupported WAV format %j', (format) => {
  expect(() => command.pcmOf(wav(format))).toThrow(
    'Narrator WAV must be PCM format 1, mono, 24000 Hz, 16-bit',
  )
})

it('rejects a truncated WAV data chunk', () => {
  const audio = wav().subarray(0, -2)
  audio.writeUInt32LE(audio.length - 8, 4)
  expect(() => command.pcmOf(audio)).toThrow('Truncated narrator WAV chunk')
})

async function fixture(sounds: JsonObject = {}) {
  const home = await temp('sounds-command-')
  await mkdir(`${home}/.ultimate`)
  await writeFile(`${home}/.ultimate/settings.json`, JSON.stringify({ sounds }))
  const project: JsonObject = {}
  const { implement, want, provided } = apis()
  const speak = vi.fn<ReadAloudService['speak']>().mockResolvedValue(pcm)
  implement(ReadAloudApi, { speak })
  const host = createTestExtensionHost({
    userHome: home,
    projectSettings: async () => ({ sounds: project }),
    want,
  })
  return {
    ctx: { host, signal: new AbortController().signal } as ActionContext,
    project,
    speak,
    provided,
  }
}

it('merges local settings and caches by source, command and text', async () => {
  const { ctx, project, speak } = await fixture({ voice: 'local', command: ['voice', 'one'] })
  const render = vi.spyOn(command, 'speakCommand').mockResolvedValue(pcm)
  const text = 'Local command cache.'
  const say = () => actions.say({ text, voice: 'cedar' }, ctx)
  expect(await say()).toEqual({ audio: pcm.toString('base64') })
  expect(render).toHaveBeenCalledWith(['voice', 'one'], text, expect.any(AbortSignal))
  expect(await say()).toEqual({ audio: pcm.toString('base64') })
  expect(render).toHaveBeenCalledTimes(1)
  expect(speak).not.toHaveBeenCalled()

  project.command = ['voice', 'two']
  await say()
  expect(render).toHaveBeenLastCalledWith(['voice', 'two'], text, expect.any(AbortSignal))
  expect(render).toHaveBeenCalledTimes(2)
  project.voice = 'openai'
  await say()
  expect(speak).toHaveBeenCalledTimes(1)
  project.voice = 'local'
  await say()
  expect(render).toHaveBeenCalledTimes(2)
})

it('falls back only to the browser on local failure or missing setup, and retries after failure', async () => {
  const { ctx, project, speak } = await fixture({ voice: 'local', command: ['voice'] })
  const render = vi.spyOn(command, 'speakCommand').mockRejectedValue(new Error('Command failed'))
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const text = 'Local command failure.'
  const say = () => actions.say({ text, voice: 'cedar' }, ctx)
  expect(await say()).toEqual({ audio: null })
  expect(warning).toHaveBeenCalledWith('Narrator command failed', expect.any(Error))
  render.mockResolvedValue(pcm)
  expect(await say()).toEqual({ audio: pcm.toString('base64') })
  expect(render).toHaveBeenCalledTimes(2)
  project.command = []
  expect(await say()).toEqual({ audio: null })
  expect(render).toHaveBeenCalledTimes(2)
  expect(speak).not.toHaveBeenCalled()
})

it('leaves off to the browser without rendering, provider access or cached audio', async () => {
  const { ctx, project, speak } = await fixture({ voice: 'off' })
  const render = vi.spyOn(command, 'speakCommand').mockResolvedValue(pcm)
  const text = 'Browser voice only.'
  const say = () => actions.say({ text, voice: 'cedar' }, ctx)
  expect(await say()).toEqual({ audio: null })
  expect(render).not.toHaveBeenCalled()
  expect(speak).not.toHaveBeenCalled()

  project.voice = 'local'
  project.command = ['voice']
  expect(await say()).toEqual({ audio: pcm.toString('base64') })
  project.voice = 'off'
  expect(await say()).toEqual({ audio: null })
  expect(render).toHaveBeenCalledTimes(1)
  expect(speak).not.toHaveBeenCalled()
})

it('speaks through read-aloud only with a selected voice and an available service', async () => {
  const { ctx, speak, provided } = await fixture()
  const text = 'Default narrator source.'
  const cedar = { text, voice: 'cedar' }
  const audio = { audio: pcm.toString('base64') }
  expect(await actions.say({ text }, ctx)).toEqual({ audio: null })
  expect(speak).not.toHaveBeenCalled()
  expect(await actions.say(cedar, ctx)).toEqual(audio)
  expect(speak).toHaveBeenCalledWith(text, 'cedar', expect.any(AbortSignal))
  expect(await actions.say(cedar, ctx)).toEqual(audio)
  expect(speak).toHaveBeenCalledTimes(1)

  speak.mockResolvedValueOnce(undefined)
  expect(await actions.say({ text, voice: 'marin' }, ctx)).toEqual({ audio: null })
  expect(speak).toHaveBeenLastCalledWith(text, 'marin', expect.any(AbortSignal))
  provided.delete(ReadAloudApi.name)
  expect(await actions.say(cedar, ctx)).toEqual({ audio: null })
  expect(speak).toHaveBeenCalledTimes(2)
})
