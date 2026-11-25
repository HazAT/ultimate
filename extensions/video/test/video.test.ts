import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { context } from '../../../server/harness.ts'
import { until } from '../../../test/helpers.ts'
import { VideoFailed, VideoReady } from '../refs.ts'
import type { Runner } from '../prepare.ts'
import { actions } from '../server.ts'
import { fixture, gemini } from './fixture.ts'
import type { Fake } from './fixture.ts'
import { GEMINI } from '../gemini.ts'

const done = { stdout: '', stderr: '' }
const succeeds: Runner = async (command, args) => {
  if (command === 'ffprobe') return { ...done, stdout: '2.4\n' }
  if (args.includes('-frames:v')) return done
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
    if (command === 'ffmpeg' && !args.includes('-frames:v')) {
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

it('prepares videos without a Gemini key and tells the caller to add GEMINI_API_KEY', async () => {
  const f = await fixture(succeeds)
  const id = await f.upload(Buffer.from('original clip'))
  expect(await f.prepared(id)).toMatchObject({ state: 'ready' })
  await expect(
    actions.ask({ id, question: 'What happens in the video?' }, f.action),
  ).rejects.toThrow(
    'Video questions need a Gemini API key: add GEMINI_API_KEY in the Secrets panel (⌘K → Secrets).',
  )
  expect((await f.state())?.threads).toEqual({})
})

const hour = 60 * 60 * 1000
function google(options: { expiresIn?: number; fail?: Response } = {}) {
  let uploads = 0
  let answers = 0
  let polls = 0
  const usage = {
    promptTokenCount: 31612,
    cachedContentTokenCount: 29535,
    candidatesTokenCount: 210,
    totalTokenCount: 31822,
  }
  const fake: Fake = (call) => {
    const file = (state: string) => ({
      name: `files/f${uploads}`,
      uri: `${GEMINI}/v1beta/files/f${uploads}`,
      state,
      expirationTime: new Date(Date.now() + (options.expiresIn ?? 47 * hour)).toISOString(),
    })
    if (call.path === '/upload/v1beta/files')
      return gemini(200, {}, { 'x-goog-upload-url': 'https://upload.example/session' })
    if (call.path === 'https://upload.example/session') {
      uploads += 1
      return gemini(200, { file: file('PROCESSING') })
    }
    if (call.method === 'GET' && call.path.startsWith('/v1beta/files/')) {
      polls += 1
      return gemini(200, file(polls % 2 ? 'PROCESSING' : 'ACTIVE'))
    }
    if (call.method === 'DELETE') return gemini(200, {})
    if (call.path.endsWith(':generateContent')) {
      answers += 1
      if (answers === 3 && options.fail) return options.fail
      return gemini(200, {
        candidates: [
          {
            content: {
              parts: [{ text: 'thinking…', thought: true }, { text: `Answer ${answers}` }],
            },
          },
        ],
        usageMetadata: usage,
      })
    }
    throw new Error(`Unexpected ${call.method} ${call.path}`)
  }
  return { fake, usage }
}

it('uploads each part once, waits for ACTIVE, asks with its file URI and replays the thread', async () => {
  const quota = gemini(429, {
    error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).' },
  })
  const { fake, usage } = google({ fail: quota })
  const f = await fixture(succeeds, fake)
  const id = await f.upload(Buffer.from('original clip'))
  expect(await f.prepared(id)).toMatchObject({ state: 'ready' })
  const options = { id, from: 0.2, to: 1.5, fps: 2, detail: 'low' } as const
  const ask = (question: string) => actions.ask({ ...options, question }, f.action)
  expect(await ask('First question')).toEqual({
    answer: 'Answer 1',
    usage,
    model: 'google/gemini-4-neon',
  })
  await f.service.ask(
    { ...options, model: 'google/gemini-4-neon', conversation: 1, question: 'Follow-up' },
    f.action.signal,
  )

  const sent = f.calls.filter(
    (call) => call.path.startsWith('/upload') || call.path.startsWith('https:'),
  )
  expect(sent.map((call) => call.path)).toEqual([
    '/upload/v1beta/files',
    'https://upload.example/session',
  ])
  expect(sent[0].headers.get('x-goog-api-key')).toBe('test-key')
  expect(sent[0].headers.get('x-goog-upload-protocol')).toBe('resumable')
  expect(sent[0].headers.get('x-goog-upload-header-content-length')).toBe('13')
  expect(sent[1].headers.get('x-goog-upload-command')).toBe('upload, finalize')
  expect(sent[1].body).toBe('original clip')
  expect(f.calls.filter((call) => call.method === 'GET').map((call) => call.path)).toEqual([
    '/v1beta/files/f1',
    '/v1beta/files/f1',
  ])
  expect((await f.state())?.videos[id]?.parts?.[0].remote).toMatchObject({
    name: 'files/f1',
    uri: `${GEMINI}/v1beta/files/f1`,
  })

  const asked = f.calls.filter((call) => call.path.endsWith(':generateContent'))
  expect(asked.map((call) => call.path)).toEqual([
    '/v1beta/models/gemini-4-neon:generateContent',
    '/v1beta/models/gemini-4-neon:generateContent',
  ])
  const first = {
    role: 'user',
    parts: [
      {
        fileData: { fileUri: `${GEMINI}/v1beta/files/f1`, mimeType: 'video/mp4' },
        videoMetadata: { startOffset: '0.2s', endOffset: '1.5s', fps: 2 },
      },
      { text: 'First question' },
    ],
  }
  const generationConfig = {
    mediaResolution: 'MEDIA_RESOLUTION_LOW',
    thinkingConfig: { thinkingLevel: 'LOW' },
  }
  expect(JSON.parse(asked[0].body!)).toEqual({ contents: [first], generationConfig })
  expect(JSON.parse(asked[1].body!)).toEqual({
    contents: [
      first,
      { role: 'model', parts: [{ text: 'Answer 1' }] },
      { role: 'user', parts: [{ text: 'Follow-up' }] },
    ],
    generationConfig,
  })

  await expect(ask('Should not be saved')).rejects.toThrow(
    "Gemini's rate limit or quota is reached (HTTP 429): Resource has been exhausted (e.g. check quota). A video question costs about 105 tokens per second of video; wait and retry, or narrow it with from/to or a lower fps.",
  )
  expect(Object.values((await f.state())!.threads)).toEqual([
    [
      { question: 'First question', answer: 'Answer 1' },
      { question: 'Follow-up', answer: 'Answer 2' },
    ],
  ])
})

it('re-uploads an expiring part, deletes uploads on remove and passes on a 402', async () => {
  const depleted = gemini(402, {
    error: {
      code: 402,
      message: 'Your prepayment credits are depleted.',
      status: 'RESOURCE_EXHAUSTED',
    },
  })
  const { fake } = google({ expiresIn: hour / 2, fail: depleted })
  const f = await fixture(succeeds, fake)
  const id = await f.upload(Buffer.from('original clip'))
  await f.prepared(id)
  await actions.ask({ id, question: 'One' }, f.action)
  await actions.ask({ id, question: 'Two' }, f.action)
  const uploads = () => f.calls.filter((call) => call.path === '/upload/v1beta/files').length
  expect(uploads()).toBe(2)
  expect((await f.state())?.videos[id]?.parts?.[0].remote?.name).toBe('files/f2')
  await expect(actions.ask({ id, question: 'Three' }, f.action)).rejects.toThrow(
    "Google's Gemini API billing is empty (HTTP 402): Your prepayment credits are depleted. Add prepayment credits to the AI Studio project of GEMINI_API_KEY, then ask again.",
  )

  expect(await actions.remove({ id }, f.action)).toBeNull()
  expect(f.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual([
    '/v1beta/files/f1',
    '/v1beta/files/f2',
    '/v1beta/files/f3',
  ])
  expect((await f.state())?.videos[id]).toBeUndefined()
})

it('serves the thumbnail preparation saved next to the parts', async () => {
  let seek: string | undefined
  const f = await fixture(async (command, args, options) => {
    if (command === 'ffmpeg' && args.includes('-frames:v')) {
      seek = args[args.indexOf('-ss') + 1]
      await writeFile(args.at(-1)!, 'jpeg bytes')
      return done
    }
    return succeeds(command, args, options)
  })
  const id = await f.upload(Buffer.from('original clip'))
  expect(await f.prepared(id)).toMatchObject({ thumbnail: 'parts/thumbnail.jpg' })
  expect(seek).toBe('1.000')
  expect(await actions.thumbnail({ id }, f.action)).toBe(
    `data:image/jpeg;base64,${Buffer.from('jpeg bytes').toString('base64')}`,
  )
})

it('keeps an upload interrupted while Google processes it, and finishes it on the next question', async () => {
  const { fake } = google()
  const asking = new AbortController()
  let polls = 0
  const f = await fixture(succeeds, (call) => {
    if (call.method === 'GET' && (polls += 1) === 1) asking.abort(new Error('stopped'))
    return fake(call)
  })
  const id = await f.upload(Buffer.from('original clip'))
  await f.prepared(id)
  await expect(
    f.service.ask({ id, conversation: 1, question: 'One' }, asking.signal),
  ).rejects.toThrow('stopped')
  expect((await f.state())?.videos[id]?.parts?.[0].remote).toMatchObject({ name: 'files/f1' })
  expect((await f.state())?.videos[id]?.parts?.[0].remote?.active).toBeUndefined()

  await actions.ask({ id, question: 'Two' }, f.action)
  expect(f.calls.filter((call) => call.path === '/upload/v1beta/files')).toHaveLength(1)
  expect((await f.state())?.videos[id]?.parts?.[0].remote).toMatchObject({
    name: 'files/f1',
    active: true,
  })
})

it('keeps a ready video and its icon when no frame was written', async () => {
  const f = await fixture(succeeds)
  const id = await f.upload(Buffer.from('original clip'))
  const video = await f.prepared(id)
  expect(video).toMatchObject({ state: 'ready' })
  expect(video?.thumbnail).toBeUndefined()
  expect(await actions.thumbnail({ id }, f.action)).toBeNull()
})

it('replaces an upload Google failed to process, and an expired one without deleting it', async () => {
  const { fake } = google({ expiresIn: -hour })
  let failed = false
  const f = await fixture(succeeds, (call) => {
    if (call.method === 'GET' && !failed) {
      failed = true
      return gemini(200, {
        name: 'files/f1',
        uri: 'u',
        state: 'FAILED',
        error: { message: 'bad codec' },
      })
    }
    return fake(call)
  })
  const id = await f.upload(Buffer.from('original clip'))
  await f.prepared(id)
  await expect(actions.ask({ id, question: 'One' }, f.action)).rejects.toThrow('bad codec')
  expect((await f.state())?.videos[id]?.parts?.[0].remote).toBeUndefined()
  await actions.ask({ id, question: 'Two' }, f.action)
  await actions.ask({ id, question: 'Three' }, f.action)
  expect(f.calls.filter((call) => call.path === '/upload/v1beta/files')).toHaveLength(3)
  expect(f.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual([
    '/v1beta/files/f1',
  ])
})
