import { basename, extname } from 'node:path'
import { MAX_CHUNK_BYTES, MAX_UPLOAD_BYTES } from './limits.ts'
import type { AskArgs, Video } from './refs.ts'

const videoMimes = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  ts: 'video/mp2t',
  ogv: 'video/ogg',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',
} as const

export const validId = (id: string) => /^v_[a-f0-9]{32}$/.test(id)

export function idOf(id: unknown) {
  if (typeof id !== 'string' || !validId(id)) throw new Error('Expected a video id')
  return id
}

export function fields(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('Expected video arguments as an object')
  return args as Record<string, unknown>
}

export function nameOf(name: unknown) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Expected a video name')
  const cleaned = basename(name.replaceAll('\\', '/'))
    .replace(/[\p{Cc}`]/gu, '')
    .trim()
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned.slice(0, 200) : 'video'
}

export function mimeOf(mimeType: unknown) {
  if (typeof mimeType !== 'string' || /[\p{Cc}]/u.test(mimeType))
    throw new Error('Expected a video/* MIME type')
  const mime = mimeType.split(';', 1)[0].trim().toLowerCase()
  if (!/^video\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime))
    throw new Error('Expected a video/* MIME type')
  return mime
}

export function mimeForPath(path: string) {
  const ext = extname(path).slice(1).toLowerCase()
  if (!Object.hasOwn(videoMimes, ext)) throw new Error('Expected a file with a video extension')
  return videoMimes[ext as keyof typeof videoMimes]
}

export function sourceFile(name: string, mimeType: string) {
  const ext = extname(name).slice(1).toLowerCase()
  const matched = Object.entries(videoMimes).find(([, mime]) => mime === mimeType)?.[0]
  return `source.${/^[a-z0-9]{1,10}$/.test(ext) ? ext : (matched ?? 'video')}`
}

export function sourceOf(source: unknown): Video['source'] {
  if (source === undefined) return 'file'
  if (
    source === 'paste' ||
    source === 'drop' ||
    source === 'recording' ||
    source === 'file' ||
    source === 'url'
  )
    return source
  throw new Error('Expected source: paste, drop, recording, file or url')
}

export function bytesOf(bytes: unknown) {
  if (
    typeof bytes !== 'number' ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > MAX_UPLOAD_BYTES
  )
    throw new Error('Expected a video byte count of at most 1 GB')
  return bytes
}

export function offsetOf(offset: unknown) {
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0)
    throw new Error('Expected a non-negative byte offset')
  return offset
}

export function chunkOf(data: unknown) {
  if (typeof data !== 'string') throw new Error('Expected a base64 video chunk')
  if (data.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4)
    throw new Error('Video chunks may contain at most 8 MB')
  if (data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    throw new Error('Expected a base64 video chunk')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > MAX_CHUNK_BYTES) throw new Error('Video chunks may contain at most 8 MB')
  return bytes
}

export function urlOf(value: unknown) {
  const url = typeof value === 'string' ? URL.parse(value) : null
  if (!url || url.protocol !== 'https:') throw new Error('Expected an HTTPS video URL')
  return url
}

export function conversationOf(conversation: unknown) {
  if (typeof conversation !== 'number' || !Number.isSafeInteger(conversation) || conversation < 1)
    throw new Error('Expected a conversation id')
  return conversation
}

function numberOf(value: unknown, field: 'from' | 'to' | 'fps') {
  if (value === undefined) return undefined
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    (field === 'fps' && value === 0)
  )
    throw new Error(`Invalid video ${field}`)
  return value
}

export function askOf(raw: unknown): AskArgs & { conversation: number; model: string } {
  const args = fields(raw)
  const id = idOf(args.id)
  const conversation = conversationOf(args.conversation)
  const question = args.question
  if (typeof question !== 'string' || !question.trim()) throw new Error('Expected a video question')
  const model =
    args.model === undefined
      ? 'gemini-4-neon'
      : typeof args.model === 'string'
        ? args.model.replace(/^google\//, '')
        : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model))
    throw new Error(
      'Choose a Gemini API model (google/<id> or a bare id, e.g. google/gemini-4-neon)',
    )
  const thinking = args.thinking
  if (thinking !== undefined && thinking !== 'low' && thinking !== 'medium' && thinking !== 'high')
    throw new Error('Video thinking must be low, medium or high')
  const from = numberOf(args.from, 'from')
  const to = numberOf(args.to, 'to')
  const fps = numberOf(args.fps, 'fps')
  if (to !== undefined && to <= (from ?? 0)) throw new Error('Video to must be greater than from')
  const detail = args.detail
  if (detail !== undefined && detail !== 'low' && detail !== 'high')
    throw new Error('Video detail must be low or high')
  return { id, conversation, question, model, thinking, from, to, fps, detail }
}
