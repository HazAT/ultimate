import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context, withAbortSignal } from '@earendil-works/chord/context'
import { defineExtension, defineTool, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { num, obj, opt, str } from '@earendil-works/pi-schema'
import { implementAction } from '../../lib/actions.ts'
import { defineEffect, effectResult } from '../../lib/effect.ts'
import { strEnum } from '../../lib/schema.ts'
import { execFile } from '../../lib/spawn.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { VideoApi } from './api.ts'
import { ask } from './ask.ts'
import { liveGoogle } from './gemini.ts'
import type { Google } from './gemini.ts'
import {
  bytesOf,
  chunkOf,
  conversationOf,
  fields,
  idOf,
  mimeOf,
  nameOf,
  offsetOf,
  sourceFile,
  sourceOf,
} from './input.ts'
import { prepareVideo } from './prepare.ts'
import type { Prepared, Runner } from './prepare.ts'
import {
  AddUrlAction,
  AppendAction,
  AskAction,
  BeginAction,
  FinishAction,
  RemoveAction,
  ThumbnailAction,
  VideoFailed,
  VideoReady,
} from './refs.ts'
import type { AskedVideo, Video } from './refs.ts'
import {
  addUrl,
  folder,
  receive,
  receivePath,
  removal,
  serialized,
  snapshot,
  sweep,
  VideosState,
  writeChunk,
} from './storage.ts'

export const docs = [VideosState]
export const pollActions = ['thumbnail']
export const secrets = [
  {
    name: 'GEMINI_API_KEY',
    description: 'Gemini API key for video_ask (billed per question)',
    url: 'https://aistudio.google.com/apikey',
    provider: 'google',
  },
]

function prepare(host: ExtensionHost, run: Runner) {
  return defineEffect<{ id: string; source: string; mimeType: string }, Prepared>(
    'video.prepare',
    ({ id, source, mimeType }, { signal }) =>
      prepareVideo(run, folder(host, id), source, mimeType, signal),
    async (tx, { id }, outcome) => {
      const doc = await tx.doc(VideosState, ROOT_CONVERSATION_ID)
      const video = doc.videos[id]
      if (!video || video.state !== 'preparing') return
      delete video.task
      if (outcome.ok) {
        video.state = 'ready'
        if (outcome.value.seconds !== undefined) video.seconds = outcome.value.seconds
        if (outcome.value.thumbnail !== undefined) video.thumbnail = outcome.value.thumbnail
        video.parts = outcome.value.parts
        await host.emit(tx, VideoReady, { id })
      } else {
        video.state = 'failed'
        video.error = outcome.error
        await host.emit(tx, VideoFailed, { id, error: outcome.error })
      }
    },
  )
}

const effects = new WeakMap<
  ExtensionHost,
  {
    Prepare: ReturnType<typeof prepare>
    queueRemoval: ReturnType<typeof removal>['queue']
    google: Google
  }
>()

function finish(host: ExtensionHost, id: string): Promise<Video> {
  return serialized(host, id, async () => {
    const video = (await snapshot(host))?.videos[id]
    if (!video) throw new Error('Unknown video')
    if (video.state === 'preparing' || video.state === 'ready') return video
    if (video.state !== 'receiving')
      throw new Error(`Video is ${video.state}${video.error ? `: ${video.error}` : ''}`)
    const source = sourceFile(video.name, video.mimeType)
    const { size } = await stat(join(folder(host, id), source))
    if (size !== video.bytes)
      throw new Error(`Video is incomplete: received ${size} of ${video.bytes} bytes`)
    const preparing = await host.harness().commit(async (tx) => {
      const doc = await tx.doc(VideosState, ROOT_CONVERSATION_ID)
      const task = await tx.createTask(
        effects.get(host)!.Prepare,
        { id, source, mimeType: video.mimeType },
        {
          conversationId: ROOT_CONVERSATION_ID,
          ownership: { kind: 'conversation' },
          background: true,
        },
      )
      const queued = { ...video, state: 'preparing', task } as const
      doc.videos[id] = queued
      return queued
    }, context)
    host.harness().resume()
    return preparing
  })
}

export default function videoExtension(
  host: ExtensionHost,
  run: Runner = execFile,
  google: Google = liveGoogle,
) {
  const Prepare = prepare(host, run)
  const { Remove, queue: queueRemoval } = removal(host, google)
  effects.set(host, { Prepare, queueRemoval, google })
  host.onOpen(async () => {
    await sweep(host, queueRemoval).catch((error: unknown) =>
      host.notice(`Video cleanup failed: ${String(error)}`),
    )
  })
  host.implement(VideoApi, {
    async ingest(from, options) {
      if ('url' in from) {
        sourceOf(options.source)
        return addUrl(host, from.url, options.name, conversationOf(options.conversation))
      }
      const { id } = await receivePath(host, from.path, options)
      return finish(host, id)
    },
    ask: (args, signal) => ask(host, google, args, signal),
  })
  return defineExtension({
    name: 'video',
    tasks: [Prepare, Remove],
    tools: [
      defineTool({
        name: 'video_ask',
        description:
          'Ask a question about a video using Gemini (official Gemini API, GEMINI_API_KEY), regardless of your model. Get the video id from the user’s attachments or video/addUrl. Costs about 105 tokens per second of video, billed to the key; use from/to to narrow the range. Follow-up questions with the same video and options are cheaper through caching.',
        parameters: obj({
          id: str({ description: 'Video id from an attachment or video/addUrl' }),
          question: str({ minLength: 1 }),
          model: opt(
            str({ description: 'Gemini API model, google/<id> (default: google/gemini-4-neon)' }),
          ),
          thinking: opt(strEnum(['low', 'medium', 'high'])),
          from: opt(num({ minimum: 0, description: 'Start time in seconds' })),
          to: opt(num({ minimum: 0, description: 'End time in seconds' })),
          detail: opt(strEnum(['low', 'high'])),
          fps: opt(num({ exclusiveMinimum: 0, description: 'Frames to sample per second' })),
        }),
        async execute(args, api, ctx) {
          let asked: AskedVideo | undefined
          const { answer, usage, model } = await ask(
            host,
            google,
            { ...args, conversation: api.conversationId },
            ctx.abortSignal ?? new AbortController().signal,
            ({ name, seconds, ...stage }) => {
              asked = { name, ...(seconds === undefined ? {} : { seconds }) }
              return api.details({ ...stage, ...asked }, ctx)
            },
          )
          const format = (count: number) => count.toLocaleString('en-US')
          const cached =
            usage.cachedContentTokenCount === undefined
              ? ''
              : ` (${format(usage.cachedContentTokenCount)} cached)`
          const summary = `Used ${format(usage.promptTokenCount)} input tokens${cached}, ${format(usage.candidatesTokenCount)} output.`
          return {
            output: [{ type: 'text', text: `${answer}\n\n${summary}` }],
            details: { stage: 'answered', usage, model, answer, ...asked },
          }
        },
      }),
    ],
  })
}

export const actions = {
  begin: implementAction(BeginAction, (args, { host, conversationId }) => {
    const { name, mimeType, bytes, source } = fields(args)
    return receive(host, {
      name: nameOf(name),
      mimeType: mimeOf(mimeType),
      bytes: bytesOf(bytes),
      source: sourceOf(source),
      conversation: conversationId ?? ROOT_CONVERSATION_ID,
    })
  }),
  append: implementAction(AppendAction, (args, { host }) => {
    const { id, offset, data } = fields(args)
    return writeChunk(host, idOf(id), offsetOf(offset), chunkOf(data))
  }),
  finish: implementAction(FinishAction, (args, { host }) => finish(host, idOf(fields(args).id))),
  addUrl: implementAction(AddUrlAction, (args, { host, conversationId }) => {
    const { url, name } = fields(args)
    return addUrl(host, url, name, conversationId ?? ROOT_CONVERSATION_ID)
  }),
  ask: implementAction(AskAction, (args, { host, conversationId, signal }) =>
    ask(
      host,
      effects.get(host)!.google,
      { ...fields(args), conversation: conversationId ?? ROOT_CONVERSATION_ID },
      signal,
    ),
  ),
  thumbnail: implementAction(ThumbnailAction, async (args, { host }) => {
    const id = idOf(fields(args).id)
    const video = (await snapshot(host))?.videos[id]
    if (!video?.thumbnail) return null
    return `data:image/jpeg;base64,${await readFile(join(folder(host, id), video.thumbnail), 'base64')}`
  }),
  remove: implementAction(RemoveAction, async (args, { host, signal }) => {
    const harness = host.harness()
    const task = await effects.get(host)!.queueRemoval(idOf(fields(args).id))
    return task === undefined ? null : effectResult(harness, task, withAbortSignal(signal, context))
  }),
}
