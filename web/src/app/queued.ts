import type { ConversationId, InboxItem } from '@earendil-works/pi-durable'
import { HttpError } from '../sdk/api.ts'

export type QueuedInput = { text: string; images: { data: string; mimeType: string }[] }

type QueueApi = {
  cancelSubmission: (submissionId: number, id?: ConversationId) => Promise<unknown>
}

/**
 * `current` with `text` replacing `start..end`, spaced from neighbouring words as typing it would be, and the cursor
 * after it.
 */
export function spliced(current: string, start: number, end: number, text: string) {
  const before = current.slice(0, start)
  const after = current.slice(end)
  const inserted = `${before && !/\s$/.test(before) ? ' ' : ''}${text}${after && !/^\s/.test(after) ? ' ' : ''}`
  return { text: before + inserted + after, cursor: start + inserted.length }
}

/** The text and images of a queued input; an entry write has none. */
export function queuedInput(item: InboxItem): QueuedInput | undefined {
  if (item.mode === 'write') return undefined
  const content = item.content
  if (typeof content === 'string') return { text: content, images: [] }
  return {
    text: content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'),
    images: content.flatMap((block) =>
      block.type === 'image' ? [{ data: block.data, mimeType: block.mimeType }] : [],
    ),
  }
}

/** The one-line form of a queued text: `↵` marks each line break, so a merged steer shows its seams. */
export const queuedLine = (text: string) => text.replace(/\s*\n\s*/g, ' ↵ ')

/**
 * The queued line as a head that may truncate and a tail that always shows, so a long text keeps its start and its
 * end with the ellipsis between them. A short last line is the tail with its seam, so a merged steer shows what was
 * added. Short texts are all head.
 */
export function previewParts(
  text: string,
  { limit = 80, tail = 40 }: { limit?: number; tail?: number } = {},
): { head: string; tail?: string } {
  const line = queuedLine(text)
  if (line.length <= limit) return { head: line }
  const seam = line.lastIndexOf(' ↵ ')
  const at = seam >= 0 && line.length - seam <= tail * 1.5 ? seam : line.length - tail
  return { head: line.slice(0, at), tail: line.slice(at) }
}

/** Whether the caret sits on the first line of `value`, where ↑ has nowhere to go. */
export const atFirstLine = (value: string, caret: number) => !value.slice(0, caret).includes('\n')

const alreadyTaken = (failure: unknown) => failure instanceof HttpError && failure.status === 409

/**
 * Withdraw the last queued steer so the new one can carry its text: its content, or undefined when none is queued or
 * the run took it meanwhile (the new steer then goes alone, and the old one is already in the transcript).
 */
export async function withdrawQueuedSteer(
  api: QueueApi,
  conversationId: ConversationId,
  items: readonly InboxItem[],
): Promise<QueuedInput | undefined> {
  const previous = items.findLast((item) => item.mode === 'steer')
  if (!previous) return undefined
  try {
    await api.cancelSubmission(previous.id, conversationId)
  } catch (failure) {
    if (alreadyTaken(failure)) return undefined
    throw failure
  }
  return queuedInput(previous)
}

/** One steer carrying the withdrawn one's text on the lines before the new text, and both inputs' images. */
export const mergedSteer = (previous: QueuedInput, next: QueuedInput): QueuedInput => ({
  text: `${previous.text}\n${next.text}`,
  images: [...previous.images, ...next.images],
})

/**
 * Withdraw every queued input, steers before follow-ups, and return their contents in that order for the editor.
 * One the run took meanwhile is left out: it is already in the transcript.
 */
export async function recallQueued(
  api: QueueApi,
  conversationId: ConversationId,
  items: readonly InboxItem[],
): Promise<QueuedInput[]> {
  const queued = [
    ...items.filter((item) => item.mode === 'steer'),
    ...items.filter((item) => item.mode === 'followUp'),
  ]
  const recovered = await Promise.all(
    queued.map(async (item) => {
      try {
        await api.cancelSubmission(item.id, conversationId)
      } catch (failure) {
        if (alreadyTaken(failure)) return undefined
        throw failure
      }
      return queuedInput(item)
    }),
  )
  return recovered.filter((input) => input !== undefined)
}

/** The editor text after a recall: the current text, then each recalled input, separated by blank lines. */
export const recalledText = (current: string, recalled: readonly QueuedInput[]) =>
  [current, ...recalled.map((input) => input.text)].filter((text) => text.trim()).join('\n\n')
