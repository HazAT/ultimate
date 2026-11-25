import type { ConversationId } from '@earendil-works/pi-durable'
import { createEffect, createRoot } from 'solid-js'
import { meansNone } from '../../lib/errors.ts'
import { api, defineWebExtension, FileUpload, provide, ROOT, useDocOf } from '@/sdk/solid'
import type { UploadSource } from '@/sdk/solid'
import { StandingDoc } from '../subagents/refs.ts'
import { VideoAskCall } from './call.solid.tsx'
import {
  AppendAction,
  BeginAction,
  FinishAction,
  RemoveAction,
  ThumbnailAction,
  VideosDoc,
} from './refs.ts'
import type { Video } from './refs.ts'
import { KEPT_MS, MAX_CHUNK_BYTES, MAX_UPLOAD_BYTES } from './limits.ts'

async function base64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

function settled(id: string, signal: AbortSignal) {
  signal.throwIfAborted()
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
  const call = { conversationId: options.conversation }
  let video: Video
  const { id } = await api.action(
    BeginAction,
    { name: file.name || 'video', mimeType: file.type, bytes: file.size, source: options.source },
    call,
  )
  try {
    for (let offset = 0; offset === 0 || offset < file.size; offset += MAX_CHUNK_BYTES) {
      signal.throwIfAborted()
      status(
        `Uploading ${Math.floor((100 * offset) / Math.max(file.size, 1))}%`,
        file.size ? offset / file.size : 0,
      )
      const data = await base64(file.slice(offset, offset + MAX_CHUNK_BYTES))
      await api.action(AppendAction, { id, offset, data }, { ...call, signal })
    }
    signal.throwIfAborted()
    status('Preparing · for Google')
    await api.action(FinishAction, { id }, { ...call, signal })
    video = await settled(id, signal)
  } catch (failure) {
    void api.action(RemoveAction, { id })
    throw failure
  }
  const image = video.thumbnail
    ? await api.action(ThumbnailAction, { id }, { ...call, signal }).catch(meansNone)
    : null
  return {
    path: '',
    line: videoLine(video),
    note: `${video.seconds === undefined ? 'Video' : `${Math.round(video.seconds)} s`} · for Google`,
    ...(image ? { image } : {}),
  }
}

const videos = { accepts: 'video/', upload, maxBytes: MAX_UPLOAD_BYTES, keptMs: KEPT_MS }

export default defineWebExtension({
  provides: [provide(FileUpload, () => () => videos)],
  tools: { video_ask: VideoAskCall },
  compact: {
    when: (conversation, docs) =>
      (docs[StandingDoc.kind] as Record<string, number> | null | undefined)?.ultimate ===
      conversation.id,
    tools: ['video_ask'],
    docs: [StandingDoc.kind],
    thread: (row) => row.calls.some((call) => call.name === 'video_ask') || 'hidden',
  },
})
