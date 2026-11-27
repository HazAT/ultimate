import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { TaskId } from '@earendil-works/pi-durable'
import { defineEffect } from '../../lib/effect.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import {
  bytesOf,
  conversationOf,
  mimeForPath,
  nameOf,
  sourceFile,
  sourceOf,
  urlOf,
  validId,
} from './input.ts'
import { gemini } from './gemini.ts'
import type { Google } from './gemini.ts'
import { KEPT_MS } from './limits.shared.ts'
import { VideoReady, VideosDoc } from './refs.ts'
import type { Video, Videos } from './refs.ts'
import { checkpointEvery } from '../../shared/checkpoint.ts'

export const VideosState = defineDoc<Videos>({
  kind: VideosDoc.kind,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: checkpointEvery(100),
  initial: () => ({ videos: {}, threads: {} }),
})

const newId = () => `v_${randomUUID().replaceAll('-', '')}`
const uploads = (host: ExtensionHost) => join(host.home, 'videos')
export const folder = (host: ExtensionHost, id: string) => join(uploads(host), id)
export const threadPrefix = (id: string) => `${id}:`
export const snapshot = (host: ExtensionHost) =>
  host.harness().snapshot(VideosState, ROOT_CONVERSATION_ID, context)

export async function serialized<T>(host: ExtensionHost, key: string, work: () => Promise<T>) {
  const pending = host.resource('video.pending', () => new Map<string, Promise<void>>())
  const prior = pending.get(key)
  const { promise, resolve } = Promise.withResolvers<void>()
  pending.set(key, promise)
  try {
    await prior
    return await work()
  } finally {
    resolve()
    if (pending.get(key) === promise) pending.delete(key)
  }
}

type Upload = Pick<Video, 'name' | 'mimeType' | 'bytes' | 'source' | 'conversation'>

export async function receive(host: ExtensionHost, upload: Upload, copyFrom?: string) {
  const id = newId()
  const video: Video = { ...upload, id, state: 'receiving', createdAt: Date.now() }
  const dir = folder(host, id)
  await mkdir(uploads(host), { recursive: true })
  await mkdir(dir)
  try {
    const path = join(dir, sourceFile(video.name, video.mimeType))
    if (copyFrom === undefined) await writeFile(path, '')
    else {
      await copyFile(copyFrom, path)
      if ((await stat(path)).size !== video.bytes) throw new Error('Video file changed during copy')
    }
    await host.harness().commit(async (tx) => {
      const doc = await tx.doc(VideosState, ROOT_CONVERSATION_ID)
      doc.videos[id] = video
    }, context)
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
  return { id }
}

export async function writeChunk(host: ExtensionHost, id: string, offset: number, bytes: Buffer) {
  return serialized(host, id, async () => {
    const video = (await snapshot(host))?.videos[id]
    if (!video || video.state !== 'receiving') throw new Error('Video is not receiving chunks')
    const path = join(folder(host, id), sourceFile(video.name, video.mimeType))
    await using file = await open(path, 'r+')
    const { size } = await file.stat()
    if (offset > size) throw new Error(`Video chunk leaves a gap after byte ${size}`)
    if (offset + bytes.length > video.bytes)
      throw new Error('Video chunk exceeds the declared size')
    let written = 0
    while (written < bytes.length) {
      const { bytesWritten } = await file.write(
        bytes,
        written,
        bytes.length - written,
        offset + written,
      )
      if (bytesWritten === 0) throw new Error('Could not write the video chunk')
      written += bytesWritten
    }
    return { received: Math.max(size, offset + written) }
  })
}

export async function addUrl(
  host: ExtensionHost,
  address: unknown,
  name: unknown,
  conversation: number,
) {
  const url = urlOf(address)
  const id = newId()
  const video: Video = {
    id,
    name: name === undefined ? nameOf(basename(url.pathname) || url.hostname) : nameOf(name),
    mimeType: 'video/mp4',
    bytes: 0,
    url: url.href,
    source: 'url',
    conversation,
    state: 'ready',
    createdAt: Date.now(),
    parts: [{ mimeType: 'video/mp4' }],
  }
  await host.harness().commit(async (tx) => {
    const doc = await tx.doc(VideosState, ROOT_CONVERSATION_ID)
    doc.videos[id] = video
    await host.emit(tx, VideoReady, { id })
  }, context)
  return video
}

export async function receivePath(
  host: ExtensionHost,
  path: string,
  options: { name?: string; source?: Video['source']; conversation: number },
) {
  if (typeof path !== 'string' || !path) throw new Error('Expected a video path')
  const name = nameOf(options.name ?? path)
  const mimeType = mimeForPath(path)
  const info = await stat(path)
  if (!info.isFile()) throw new Error('Expected a regular video file')
  return receive(
    host,
    {
      name,
      mimeType,
      bytes: bytesOf(info.size),
      source: sourceOf(options.source),
      conversation: conversationOf(options.conversation),
    },
    path,
  )
}

function forget(doc: Videos, id: string) {
  delete doc.videos[id]
  for (const key of Object.keys(doc.threads))
    if (key.startsWith(threadPrefix(id))) delete doc.threads[key]
}

async function forgetUploads(host: ExtensionHost, google: Google, id: string, signal: AbortSignal) {
  const names = ((await snapshot(host))?.videos[id]?.parts ?? []).flatMap((part) =>
    part.remote && part.remote.expiresAt > Date.now() ? [part.remote.name] : [],
  )
  if (!names.length) return
  const client = await gemini(host.userHome, google)
  if (!client)
    return host.notice(
      `Could not delete ${names.length} uploaded video part(s) from Google without GEMINI_API_KEY; Google deletes them within 48 hours.`,
    )
  for (const name of names)
    await client.remove(name, signal).catch((error: unknown) => {
      signal.throwIfAborted()
      host.notice(
        `Could not confirm that Google deleted ${name} (${String(error)}); Google deletes it within 48 hours.`,
      )
    })
}

export function removal(host: ExtensionHost, google: Google) {
  const Remove = defineEffect<{ id: string; task?: TaskId }, null>(
    'video.remove',
    async ({ id, task }, { context: runContext, signal }) => {
      if (task !== undefined) {
        const harness = host.harness()
        await harness.abortTask(task, runContext)
        await harness.waitForTask(task, runContext)
      }
      signal.throwIfAborted()
      await forgetUploads(host, google, id, signal)
      await rm(folder(host, id), { recursive: true, force: true })
      return null
    },
    async (tx, { id }, outcome) => {
      const doc = await tx.doc(VideosState, ROOT_CONVERSATION_ID)
      const video = doc.videos[id]
      if (video?.state !== 'removing') return
      if (outcome.ok) forget(doc, id)
      else {
        video.state = 'failed'
        video.error = outcome.error
      }
    },
  )

  const queue = (id: string) =>
    serialized(host, id, () =>
      host.harness().commit(async (tx) => {
        const doc = await tx.doc(VideosState, ROOT_CONVERSATION_ID)
        const video = doc.videos[id]
        if (!video || video.state === 'removing') return undefined
        const task = video.state === 'preparing' ? video.task : undefined
        const removalTask = await tx.createTask(
          Remove,
          { id, ...(task === undefined ? {} : { task }) },
          {
            conversationId: ROOT_CONVERSATION_ID,
            ownership: { kind: 'conversation' },
            background: true,
          },
        )
        video.state = 'removing'
        delete video.task
        return removalTask
      }, context),
    )
  return { Remove, queue }
}

export async function sweep(
  host: ExtensionHost,
  queueRemoval: ReturnType<typeof removal>['queue'],
) {
  const cutoff = Date.now() - KEPT_MS
  const videos = (await snapshot(host))?.videos ?? {}
  for (const video of Object.values(videos))
    if (video.createdAt < cutoff && video.state !== 'removing') await queueRemoval(video.id)
  const dirs = await readdir(uploads(host), { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    },
  )
  for (const dir of dirs) {
    if (!dir.isDirectory() || !validId(dir.name) || videos[dir.name]) continue
    const path = folder(host, dir.name)
    const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (info && info.mtimeMs < cutoff) await rm(path, { recursive: true, force: true })
  }
}
