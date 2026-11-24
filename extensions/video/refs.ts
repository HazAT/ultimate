/** Videos, their question threads, and the actions and events for supplying and asking about them. */
import type { TaskId } from '@earendil-works/pi-durable'
import { actionRef, docRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'
import type { AskResult } from './types.ts'

export type Video = {
  id: string
  name: string
  mimeType: string
  bytes: number
  seconds?: number
  source: 'paste' | 'drop' | 'recording' | 'file' | 'url'
  url?: string
  conversation: number
  state: 'receiving' | 'preparing' | 'ready' | 'failed' | 'removing'
  task?: TaskId
  error?: string
  createdAt: number
  parts?: { file?: string; mimeType: string; seconds?: number; bytes?: number }[]
}

export type Turn = { question: string; answer: string }
export type Videos = { videos: Record<string, Video>; threads: Record<string, Turn[]> }
export type AskArgs = {
  id: string
  question: string
  model?: string
  from?: number
  to?: number
  detail?: 'low' | 'high'
  fps?: number
}

/** The video catalogue and per-conversation question threads on the root conversation. */
export const VideosDoc = docRef<Videos>('video.videos')
/** `{ name, mimeType, bytes, source? }` → `{ id }`: reserve storage for a video upload. */
export const BeginAction = actionRef<
  { name: string; mimeType: string; bytes: number; source?: Video['source'] },
  { id: string }
>('video', 'begin')
/** `{ id, offset, data }` → `{ received }`: write a base64 chunk at its byte offset. */
export const AppendAction = actionRef<
  { id: string; offset: number; data: string },
  { received: number }
>('video', 'append')
/** `{ id }` → `Video`: queue preparation after the upload is complete. */
export const FinishAction = actionRef<{ id: string }, Video>('video', 'finish')
/** `{ url, name? }` → `Video`: register an HTTPS video URL without downloading it. */
export const AddUrlAction = actionRef<{ url: string; name?: string }, Video>('video', 'addUrl')
/** `{ id, question, model?, from?, to?, detail?, fps? }` → `{ answer, usage, model }`. */
export const AskAction = actionRef<AskArgs, AskResult>('video', 'ask')
/** `{ id }` → `null`: delete a video, its files and all its threads. */
export const RemoveAction = actionRef<{ id: string }, null>('video', 'remove')
/** A video can now be asked about. */
export const VideoReady = defineEvent<{ id: string }>('video.ready')
/** Preparation ended without a usable video. */
export const VideoFailed = defineEvent<{ id: string; error: string }>('video.failed', {
  fails: 'video.ready',
})
