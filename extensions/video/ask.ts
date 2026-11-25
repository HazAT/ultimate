import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { gemini, GeminiError, missingKey } from './gemini.ts'
import type { Gemini, Google } from './gemini.ts'
import { askOf } from './input.ts'
import type { AskArgs, AskingDetails, Turn, Video } from './refs.ts'
import { folder, serialized, snapshot, threadPrefix, VideosState } from './storage.ts'
import type { AskResult, GeminiUsage, RemoteFile } from './types.ts'

type Part = NonNullable<Video['parts']>[number]
type Options = Pick<AskArgs, 'from' | 'to' | 'fps' | 'detail'>
const REUSE_MARGIN_MS = 60 * 60 * 1000
const offset = (seconds: number) => `${seconds.toFixed(9).replace(/\.?0+$/, '')}s`

function selectParts(parts: Part[], { from, to, fps }: Options) {
  let start = 0
  const selected = []
  for (const [index, part] of parts.entries()) {
    const end = part.seconds === undefined ? Infinity : start + part.seconds
    const left = Math.max(start, from ?? 0)
    const right = Math.min(end, to ?? Infinity)
    if (left < right) {
      const metadata = {
        ...(from === undefined ? {} : { startOffset: offset(left - start) }),
        ...(to === undefined ? {} : { endOffset: offset(right - start) }),
        ...(fps === undefined ? {} : { fps }),
      }
      selected.push({
        index,
        part,
        left,
        right,
        metadata: Object.keys(metadata).length ? metadata : undefined,
      })
    }
    start = end
  }
  if (!selected.length) throw new Error('The requested range does not overlap the video')
  return selected
}

function uploaded(
  host: ExtensionHost,
  client: Gemini,
  video: Video,
  index: number,
  signal: AbortSignal,
): Promise<RemoteFile> {
  return serialized(host, `upload:${video.id}:${index}`, async () => {
    const record = (remote: RemoteFile) =>
      host.harness().commit(async (tx) => {
        const doc = await tx.doc(VideosState, ROOT_CONVERSATION_ID)
        const part = doc.videos[video.id]?.parts?.[index]
        if (doc.videos[video.id]?.state !== 'ready' || !part) return false
        part.remote = remote
        return true
      }, context)
    const forget = (name: string) =>
      host.harness().commit(async (tx) => {
        const part = (await tx.doc(VideosState, ROOT_CONVERSATION_ID)).videos[video.id]?.parts?.[
          index
        ]
        if (part?.remote?.name === name) delete part.remote
      }, context)
    const removed = async (name: string) => {
      await client.remove(name, signal)
      return new Error('Video was removed while the question was running')
    }
    const current = (await snapshot(host))?.videos[video.id]?.parts?.[index]
    if (!current?.file) throw new Error('Video was removed while the question was running')
    let remote = current.remote
    if (remote && remote.expiresAt <= Date.now() + REUSE_MARGIN_MS) {
      if (remote.expiresAt > Date.now()) await client.remove(remote.name, signal)
      remote = undefined
    }
    if (!remote) {
      remote = await client.upload(
        join(folder(host, video.id), current.file),
        current.mimeType,
        `${video.id} ${video.name}`,
        signal,
      )
      if (!(await record(remote))) throw await removed(remote.name)
    }
    if (remote.active) return remote
    const pending = remote
    const active = {
      ...(await client.active(pending.name, signal).catch(async (error: unknown) => {
        if (error instanceof GeminiError && error.status === 422) {
          await client.remove(pending.name, signal)
          await forget(pending.name)
        }
        throw error
      })),
      active: true,
    }
    if (!(await record(active))) throw await removed(active.name)
    return active
  })
}

function request(
  file: { fileUri: string; mimeType: string },
  metadata: object | undefined,
  turns: Turn[],
  question: string,
  { detail, thinking }: Pick<AskArgs, 'detail' | 'thinking'>,
) {
  const text = (role: 'user' | 'model', value: string) => ({ role, parts: [{ text: value }] })
  return {
    contents: [
      {
        role: 'user',
        parts: [
          { fileData: file, ...(metadata ? { videoMetadata: metadata } : {}) },
          { text: turns[0]?.question ?? question },
        ],
      },
      ...turns.flatMap((prior, index) => [
        ...(index > 0 ? [text('user', prior.question)] : []),
        text('model', prior.answer),
      ]),
      ...(turns.length ? [text('user', question)] : []),
    ],
    generationConfig: {
      ...(detail ? { mediaResolution: `MEDIA_RESOLUTION_${detail.toUpperCase()}` } : {}),
      thinkingConfig: { thinkingLevel: (thinking ?? 'low').toUpperCase() },
    },
  }
}

function explained(error: unknown) {
  if (!(error instanceof GeminiError)) return error
  const advice =
    error.status === 402
      ? "Google's Gemini API billing is empty (HTTP 402)"
      : error.status === 429
        ? "Gemini's rate limit or quota is reached (HTTP 429)"
        : `The Gemini API refused the request (HTTP ${error.status})`
  const next =
    error.status === 429
      ? ' A video question costs about 105 tokens per second of video; wait and retry, or narrow it with from/to or a lower fps.'
      : error.status === 402
        ? ' Add prepayment credits to the AI Studio project of GEMINI_API_KEY, then ask again.'
        : ''
  return new Error(`${advice}: ${error.message}${next}`, { cause: error })
}

function addUsage(a: GeminiUsage, b: GeminiUsage): GeminiUsage {
  const optional = (x?: number, y?: number) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0)
  const cached = optional(a.cachedContentTokenCount, b.cachedContentTokenCount)
  const thoughts = optional(a.thoughtsTokenCount, b.thoughtsTokenCount)
  return {
    promptTokenCount: a.promptTokenCount + b.promptTokenCount,
    candidatesTokenCount: a.candidatesTokenCount + b.candidatesTokenCount,
    totalTokenCount: a.totalTokenCount + b.totalTokenCount,
    ...(cached === undefined ? {} : { cachedContentTokenCount: cached }),
    ...(thoughts === undefined ? {} : { thoughtsTokenCount: thoughts }),
  }
}

export function ask(
  host: ExtensionHost,
  google: Google,
  raw: unknown,
  signal: AbortSignal,
  onStage: (stage: AskingDetails) => Promise<void> | void = () => {},
): Promise<AskResult> {
  const args = askOf(raw)
  const { id, conversation, question, model, from, to, fps, detail } = args
  const key = threadPrefix(id) + JSON.stringify([conversation, from, to, fps, detail])
  return serialized(host, key, async () => {
    signal.throwIfAborted()
    const current = await snapshot(host)
    const video = current?.videos[id]
    if (!video) throw new Error('Unknown video')
    if (video.state !== 'ready')
      throw new Error(`Video is ${video.state}${video.error ? `: ${video.error}` : ''}`)
    const turns = current?.threads[key] ?? []
    const segments = video.parts ?? []
    const parts = selectParts(segments, args)
    const client = await gemini(host.userHome, google)
    if (!client) throw new Error(missingKey)
    const answers: string[] = []
    let usage: GeminiUsage | undefined
    for (const [count, { index, part, left, right, metadata }] of parts.entries()) {
      signal.throwIfAborted()
      await onStage({
        stage: 'asking',
        part: count + 1,
        parts: parts.length,
        name: video.name,
        ...(video.seconds === undefined ? {} : { seconds: video.seconds }),
      })
      try {
        const fileUri = part.file
          ? (await uploaded(host, client, video, index, signal)).uri
          : video.url!
        const result = await client.generate(
          model,
          request({ fileUri, mimeType: part.mimeType }, metadata, turns, question, args),
          signal,
        )
        answers.push(
          segments.length === 1
            ? result.text
            : `[${offset(left)}–${offset(right)}]\n${result.text}`,
        )
        usage = usage ? addUsage(usage, result.usage) : result.usage
      } catch (error) {
        throw explained(error)
      }
    }
    const answer = answers.join('\n\n')
    await host.harness().commit(async (tx) => {
      const doc = await tx.doc(VideosState, ROOT_CONVERSATION_ID)
      if (!doc.videos[id]) throw new Error('Video was removed while the answer was running')
      doc.threads[key] = [...turns, { question, answer }]
    }, context)
    return { answer, usage: usage!, model: `google/${model}` }
  })
}
