import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { context } from '../../../server/harness.ts'
import { until } from '../../../test/helpers.ts'
import { VideoFailed, VideoReady } from '../refs.ts'
import type { Runner } from '../prepare.ts'
import { actions } from '../server.ts'
import { fixture } from './fixture.ts'

const done = { stdout: '', stderr: '' }
const succeeds: Runner = async (command, args) => {
  if (command === 'ffprobe') return { ...done, stdout: '2.4\n' }
  await copyFile(args[args.indexOf('-i') + 1], args.at(-1)!.replace('%03d', '000'))
  await writeFile(args[args.indexOf('-segment_list') + 1], 'part-000.mp4,0.000000,2.400000\n')
  return done
}

const waitForAbort = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    signal.throwIfAborted()
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })

it('writes upload chunks by position without duplicating retries or allowing gaps', async () => {
  const f = await fixture(succeeds)
  const { id } = await actions.begin(
    { name: 'clip.mp4', mimeType: 'video/mp4', bytes: 6, source: 'drop' },
    f.action,
  )
  const append = (offset: number, data: number[]) =>
    actions.append({ id, offset, data: Buffer.from(data).toString('base64') }, f.action)
  expect(await append(0, [0, 255, 127])).toEqual({ received: 3 })
  await expect(append(4, [1])).rejects.toThrow('gap after byte 3')
  await expect(actions.finish({ id }, f.action)).rejects.toThrow('received 3 of 6 bytes')
  expect(await append(3, [45, 2, 68])).toEqual({ received: 6 })
  expect(await append(0, [0, 255, 127])).toEqual({ received: 6 })
  expect(await readFile(join(f.home, 'videos', id, 'source.mp4'))).toEqual(
    Buffer.from([0, 255, 127, 45, 2, 68]),
  )
})

it('stores ffmpeg stderr and emits video.failed when preparation fails', async () => {
  const f = await fixture(async (command, args, options) => {
    if (command !== 'ffmpeg') return succeeds(command, args, options)
    throw Object.assign(new Error('ffmpeg exited 1'), {
      stderr: 'Decoder rejected the bitstream\nCould not write output\n',
    })
  })
  const id = await f.upload(Buffer.from('bad video'))
  const error = 'ffmpeg: Decoder rejected the bitstream\nCould not write output'
  expect(await f.prepared(id)).toMatchObject({ state: 'failed', error })
  expect(
    (await f.recent({ events: [VideoReady, VideoFailed] })).map(({ name, data }) => ({
      name,
      data,
    })),
  ).toEqual([{ name: 'video.failed', data: { id, error } }])
})

it('resumes a prepare interrupted by closing the harness and cleans its scratch output', async () => {
  const launched = Promise.withResolvers<string>()
  const resumedScratch: string[] = []
  let interrupted = false
  const f = await fixture(async (command, args, options) => {
    if (command === 'ffmpeg') {
      const scratch = dirname(args.at(-1)!)
      if (interrupted) resumedScratch.push(scratch)
      else {
        await writeFile(join(scratch, 'part-000.mp4'), 'incomplete output')
        const aborted = waitForAbort(options.signal)
        launched.resolve(scratch)
        return aborted
      }
    }
    return succeeds(command, args, options)
  })
  const bytes = Buffer.from('original clip')
  const id = await f.upload(bytes)
  const scratch = await launched.promise
  expect(await actions.finish({ id }, f.action)).toMatchObject({ state: 'preparing' })
  await f.close()
  await mkdir(scratch, { recursive: true })
  await writeFile(join(scratch, 'part-001.mp4'), 'incomplete output left by a crash')
  interrupted = true
  await f.open()
  expect(await f.prepared(id)).toMatchObject({
    state: 'ready',
    seconds: 2.4,
    parts: [{ file: 'parts/part-000.mp4' }],
  })
  expect(resumedScratch).toHaveLength(1)
  expect(resumedScratch[0]).not.toBe(scratch)
  await expect(stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' })
  const parts = join(f.home, 'videos', id, 'parts')
  expect(await readdir(parts)).toEqual(['part-000.mp4'])
  expect(await readFile(join(parts, 'part-000.mp4'))).toEqual(bytes)
  expect(
    (await f.recent({ events: [VideoReady, VideoFailed] })).map(({ name, data }) => ({
      name,
      data,
    })),
  ).toEqual([{ name: 'video.ready', data: { id } }])
})

it('resumes removal after a crash and aborts preparation without a failure event', async () => {
  const launched = Promise.withResolvers<void>()
  const f = await fixture(async (command, args, options) => {
    if (command !== 'ffmpeg') return succeeds(command, args, options)
    await writeFile(args.at(-1)!.replace('%03d', '000'), 'incomplete output')
    const aborted = waitForAbort(options.signal)
    launched.resolve()
    return aborted
  })
  const id = await f.upload(Buffer.from('original clip'))
  await launched.promise
  const video = (await f.state())?.videos[id]
  expect(video).toMatchObject({ state: 'preparing', task: expect.any(Number) })

  f.harness().hold()
  const removing = actions.remove({ id }, f.action).catch((error: unknown) => error)
  await until(async () => (await f.state())?.videos[id]?.state === 'removing')
  await expect(actions.ask({ id, question: 'What happens?' }, f.action)).rejects.toThrow(
    'Video is removing',
  )
  expect(await actions.remove({ id }, f.action)).toBeNull()
  await f.close()
  expect(await removing).toBeInstanceOf(Error)

  await f.open()
  await until(async () => !(await f.state())?.videos[id])
  await expect(stat(join(f.home, 'videos', id))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await f.harness().waitForTask(video!.task!, context)).toMatchObject({
    state: { status: 'terminal', outcome: { status: 'aborted' } },
  })
  expect(await f.recent({ events: [VideoFailed] })).toEqual([])
})

it('prepares videos without Antigravity and tells the caller how to enable questions', async () => {
  const f = await fixture(succeeds)
  const id = await f.upload(Buffer.from('original clip'))
  expect(await f.prepared(id)).toMatchObject({ state: 'ready' })
  await expect(
    actions.ask({ id, question: 'What happens in the video?' }, f.action),
  ).rejects.toThrow(
    'Video questions need the antigravity extension: enable it in ⌘K → Extensions and sign in with agy.',
  )
  expect((await f.state())?.threads).toEqual({})
})

it('streams the video first, replays a prior Q&A, and leaves the thread unchanged on a 429', async () => {
  const requests: unknown[] = []
  const usage = {
    promptTokenCount: 31612,
    cachedContentTokenCount: 29535,
    candidatesTokenCount: 210,
    totalTokenCount: 31822,
  }
  const f = await fixture(succeeds, async (model, body) => {
    expect(model).toBe('gemini-4-neon-low')
    expect(Symbol.asyncIterator in body).toBe(true)
    const chunks = []
    for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
    if (requests.length === 3)
      throw Object.assign(new Error('Subscription exhausted'), { status: 429 })
    return { text: `Answer ${requests.length}`, usage }
  })
  const bytes = Buffer.alloc(3 * 64 * 1024 + 5, 171)
  const id = await f.upload(bytes)
  expect(await f.prepared(id)).toMatchObject({ state: 'ready' })
  const options = { id, from: 0.2, to: 1.5, fps: 2, detail: 'low' } as const
  const ask = (question: string) => actions.ask({ ...options, question }, f.action)
  expect(await ask('First question')).toEqual({
    answer: 'Answer 1',
    usage,
    model: 'gemini-4-neon-low',
  })
  await f.service.ask(
    { ...options, model: 'antigravity/gemini-4-neon-low', conversation: 1, question: 'Follow-up' },
    f.action.signal,
  )

  const first = {
    role: 'user',
    parts: [
      {
        inlineData: { mimeType: 'video/mp4', data: bytes.toString('base64') },
        videoMetadata: { startOffset: '0.2s', endOffset: '1.5s', fps: 2 },
      },
      { text: 'First question' },
    ],
  }
  const config = { generationConfig: { mediaResolution: 'MEDIA_RESOLUTION_LOW' } }
  expect(requests[0]).toEqual({ contents: [first], ...config })
  expect(requests[1]).toEqual({
    contents: [
      first,
      { role: 'model', parts: [{ text: 'Answer 1' }] },
      { role: 'user', parts: [{ text: 'Follow-up' }] },
    ],
    ...config,
  })
  await expect(ask('Should not be saved')).rejects.toThrow(
    "Antigravity's rate limit or quota is reached (HTTP 429): Subscription exhausted. A video question costs about 105 tokens per second of video; wait and retry, or narrow it with from/to or a lower fps.",
  )
  expect(Object.values((await f.state())!.threads)).toEqual([
    [
      { question: 'First question', answer: 'Answer 1' },
      { question: 'Follow-up', answer: 'Answer 2' },
    ],
  ])
})
