import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { AntigravityApi } from '../antigravity/api.ts'
import type { GeminiUsage } from '../antigravity/api.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { askOf } from './input.ts'
import type { AskArgs, Turn, Video } from './refs.ts'
import { folder, serialized, snapshot, threadPrefix, VideosState } from './storage.ts'
import type { AskResult } from './types.ts'

type Part = NonNullable<Video['parts']>[number]
type Options = Pick<AskArgs, 'from' | 'to' | 'fps' | 'detail'>
const offset = (seconds: number) => `${seconds.toFixed(9).replace(/\.?0+$/, '')}s`

function selectParts(parts: Part[], { from, to, fps }: Options) {
  let start = 0
  const selected = []
  for (const part of parts) {
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

async function* base64(path: string, signal: AbortSignal) {
  const stream = createReadStream(path, { highWaterMark: 3 * 64 * 1024, signal })
  let tail: Buffer = Buffer.alloc(0)
  for await (const data of stream) {
    const chunk = tail.length ? Buffer.concat([tail, data as Buffer]) : (data as Buffer)
    const length = chunk.length - (chunk.length % 3)
    if (length) yield Buffer.from(chunk.toString('base64', 0, length))
    tail = chunk.subarray(length)
  }
  if (tail.length) yield Buffer.from(tail.toString('base64'))
}

async function* request(
  host: ExtensionHost,
  video: Video,
  { part, metadata }: ReturnType<typeof selectParts>[number],
  turns: Turn[],
  question: string,
  detail: Options['detail'],
  signal: AbortSignal,
) {
  yield Buffer.from('{"contents":[{"role":"user","parts":[')
  const videoMetadata = metadata ? { videoMetadata: metadata } : {}
  if (part.file) {
    yield Buffer.from(`{"inlineData":{"mimeType":${JSON.stringify(part.mimeType)},"data":"`)
    yield* base64(join(folder(host, video.id), part.file), signal)
    yield Buffer.from(`"}${metadata ? `,"videoMetadata":${JSON.stringify(metadata)}` : ''}}`)
  } else {
    yield Buffer.from(
      JSON.stringify({
        fileData: { fileUri: video.url, mimeType: part.mimeType },
        ...videoMetadata,
      }),
    )
  }

  const turn = (role: 'user' | 'model', text: string) =>
    Buffer.from(`,${JSON.stringify({ role, parts: [{ text }] })}`)
  yield Buffer.from(`,${JSON.stringify({ text: turns[0]?.question ?? question })}]}`)
  for (const [index, prior] of turns.entries()) {
    if (index > 0) yield turn('user', prior.question)
    yield turn('model', prior.answer)
  }
  if (turns.length) yield turn('user', question)
  const config = detail
    ? `,"generationConfig":{"mediaResolution":"MEDIA_RESOLUTION_${detail.toUpperCase()}"}`
    : ''
  yield Buffer.from(`]${config}}`)
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

export function ask(host: ExtensionHost, raw: unknown, signal: AbortSignal): Promise<AskResult> {
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
    const antigravity = host.want(AntigravityApi)
    if (!antigravity)
      throw new Error(
        'Video questions need the antigravity extension: enable it in ⌘K → Extensions and sign in with agy.',
      )
    const answers: string[] = []
    let usage: GeminiUsage | undefined
    for (const selected of parts) {
      signal.throwIfAborted()
      const body = request(host, video, selected, turns, question, detail, signal)
      try {
        const result = await antigravity.generate(model, body, signal)
        const { left, right } = selected
        answers.push(
          segments.length === 1
            ? result.text
            : `[${offset(left)}–${offset(right)}]\n${result.text}`,
        )
        usage = usage ? addUsage(usage, result.usage) : result.usage
      } catch (error) {
        if (!(error instanceof Error) || !('status' in error) || error.status !== 429) throw error
        throw new Error(
          `Antigravity's rate limit or quota is reached (HTTP 429): ${error.message}. A video question costs about 105 tokens per second of video; wait and retry, or narrow it with from/to or a lower fps.`,
          { cause: error },
        )
      }
    }
    const answer = answers.join('\n\n')
    await host.harness().commit(async (tx) => {
      const doc = await tx.doc(VideosState, ROOT_CONVERSATION_ID)
      if (!doc.videos[id]) throw new Error('Video was removed while the answer was running')
      doc.threads[key] = [...turns, { question, answer }]
    }, context)
    return { answer, usage: usage!, model }
  })
}
