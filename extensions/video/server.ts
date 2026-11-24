import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context, withAbortSignal } from '@earendil-works/chord/context'
import { defineExtension, defineTool, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { num, obj, opt, str } from '@earendil-works/pi-schema'
import { implementAction } from '../../lib/actions.ts'
import { defineEffect, effectResult } from '../../lib/effect.ts'
import { strEnum } from '../../lib/schema.ts'
import { execFile } from '../../lib/spawn.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { AntigravityApi } from '../antigravity/api.ts'
import { VideoApi } from './api.ts'
import { ask } from './ask.ts'
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
  VideoFailed,
  VideoReady,
} from './refs.ts'
import type { Video } from './refs.ts'
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

export default function videoExtension(host: ExtensionHost, run: Runner = execFile) {
  host.want(AntigravityApi)
  const Prepare = prepare(host, run)
  const { Remove, queue: queueRemoval } = removal(host)
  effects.set(host, { Prepare, queueRemoval })
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
    ask: (args, signal) => ask(host, args, signal),
  })
  return defineExtension({
    name: 'video',
    tasks: [Prepare, Remove],
    tools: [
      defineTool({
        name: 'video_ask',
        description:
          'Ask a question about a video using Gemini through Antigravity, regardless of your model. Get the video id from the user’s attachments or video/addUrl. Costs about 105 tokens per second of video; use from/to to narrow the range. Follow-up questions with the same video and options are cheaper through caching.',
        parameters: obj({
          id: str({ description: 'Video id from an attachment or video/addUrl' }),
          question: str({ minLength: 1 }),
          model: opt(str({ description: 'Antigravity model id (default: gemini-4-neon-low)' })),
          from: opt(num({ minimum: 0, description: 'Start time in seconds' })),
          to: opt(num({ minimum: 0, description: 'End time in seconds' })),
          detail: opt(strEnum(['low', 'high'])),
          fps: opt(num({ exclusiveMinimum: 0, description: 'Frames to sample per second' })),
        }),
        async execute(args, api, ctx) {
          const { answer, usage } = await ask(
            host,
            { ...args, conversation: api.conversationId },
            ctx.abortSignal ?? new AbortController().signal,
          )
          const format = (count: number) => count.toLocaleString('en-US')
          const cached =
            usage.cachedContentTokenCount === undefined
              ? ''
              : ` (${format(usage.cachedContentTokenCount)} cached)`
          const summary = `Used ${format(usage.promptTokenCount)} input tokens${cached}, ${format(usage.candidatesTokenCount)} output.`
          return { output: [{ type: 'text', text: `${answer}\n\n${summary}` }], details: { usage } }
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
    ask(host, { ...fields(args), conversation: conversationId ?? ROOT_CONVERSATION_ID }, signal),
  ),
  remove: implementAction(RemoveAction, async (args, { host, signal }) => {
    const harness = host.harness()
    const task = await effects.get(host)!.queueRemoval(idOf(fields(args).id))
    return task === undefined ? null : effectResult(harness, task, withAbortSignal(signal, context))
  }),
}
