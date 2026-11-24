import type { ConversationId } from '@earendil-works/pi-durable'
import { createEffect, createRoot } from 'solid-js'
import { api, defineWebExtension, FileUpload, provide, ROOT, useDocOf } from '@/sdk/solid'
import type { UploadSource } from '@/sdk/solid'
import { AppendAction, BeginAction, FinishAction, RemoveAction, VideosDoc } from './refs.ts'
import type { Video } from './refs.ts'

const CHUNK_BYTES = 8 * 1024 * 1024
const MAX_BYTES = 1024 ** 3
const KEPT_MS = 30 * 24 * 60 * 60 * 1000

async function base64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

function settled(id: string, signal: AbortSignal) {
  return new Promise<Video>((resolve, reject) =>
    createRoot((dispose) => {
      const doc = useDocOf(() => ROOT, VideosDoc)
      const done = () => {
        signal.removeEventListener('abort', aborted)
        dispose()
      }
      const aborted = () => {
        done()
        reject(signal.reason)
      }
      signal.addEventListener('abort', aborted)
      createEffect(
        () => {
          const video = doc()?.videos[id]
          return video && { ...video }
        },
        (video) => {
          if (video?.state === 'ready') {
            done()
            resolve(video)
          } else if (video?.state === 'failed') {
            done()
            reject(new Error(video.error ?? 'Video preparation failed'))
          }
        },
      )
    }),
  )
}

export const videoLine = (video: Pick<Video, 'id' | 'name' | 'seconds'>) =>
  `Attached video: \`${video.name}\` (${video.seconds === undefined ? 'length unknown' : `${Math.round(video.seconds)} s`}), id \`${video.id}\`; ask about it with video_ask`

async function upload(
  file: File,
  options: {
    source: UploadSource
    conversation: ConversationId | undefined
    status: (note: string, progress?: number) => void
    signal: AbortSignal
  },
) {
  const { status, signal } = options
  const call = { conversationId: options.conversation, signal }
  const { id } = await api.action(
    BeginAction,
    { name: file.name || 'video', mimeType: file.type, bytes: file.size, source: options.source },
    call,
  )
  try {
    for (let offset = 0; offset < file.size || offset === 0; offset += CHUNK_BYTES) {
      status(
        `Uploading ${Math.floor((100 * offset) / Math.max(file.size, 1))}%`,
        offset / file.size,
      )
      const data = await base64(file.slice(offset, offset + CHUNK_BYTES))
      await api.action(AppendAction, { id, offset, data }, call)
      if (file.size === 0) break
    }
    status('Preparing · for Google')
    const ready = settled(id, signal)
    await api.action(FinishAction, { id }, call)
    const video = await ready
    return {
      path: '',
      line: videoLine(video),
      note: `${video.seconds === undefined ? 'Video' : `${Math.round(video.seconds)} s`} · for Google`,
    }
  } catch (failure) {
    if (signal.aborted) void api.action(RemoveAction, { id })
    throw failure
  }
}

const videos = { accepts: 'video/', upload, maxBytes: MAX_BYTES, keptMs: KEPT_MS }

export default defineWebExtension({ provides: [provide(FileUpload, () => () => videos)] })
