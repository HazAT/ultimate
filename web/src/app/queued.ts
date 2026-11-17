import type { ConversationId, InboxItem } from '@earendil-works/pi-durable'
import { HttpError } from '../sdk/api.ts'

export type QueuedInput = { text: string; images: { data: string; mimeType: string }[] }

type QueueApi = {
  cancelSubmission: (submissionId: number, id?: ConversationId) => Promise<unknown>
}

export function spliced(current: string, start: number, end: number, text: string) {
  const before = current.slice(0, start)
  const after = current.slice(end)
  const inserted = `${before && !/\s$/.test(before) ? ' ' : ''}${text}${after && !/^\s/.test(after) ? ' ' : ''}`
  return { text: before + inserted + after, cursor: start + inserted.length }
}

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

export const queuedLine = (text: string) => text.replace(/\s*\n\s*/g, ' ↵ ')

export function previewParts(
  text: string,
  { limit = 80, tail = 40 }: { limit?: number; tail?: number } = {},
): { head: string; tail?: string } {
  const line = queuedLine(text)
  if (line.length <= limit) return { head: line }
  const seam = line.lastIndexOf(' ↵ ')
  const lastMergedLineFitsTail = seam >= 0 && line.length - seam <= tail * 1.5
  const at = lastMergedLineFitsTail ? seam : line.length - tail
  return { head: line.slice(0, at), tail: line.slice(at) }
}

export const atFirstLine = (value: string, caret: number) => !value.slice(0, caret).includes('\n')

const takenByRunBeforeWithdrawal = (failure: unknown) =>
  failure instanceof HttpError && failure.status === 409

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
    if (takenByRunBeforeWithdrawal(failure)) return undefined
    throw failure
  }
  return queuedInput(previous)
}

export const mergedSteer = (previous: QueuedInput, next: QueuedInput): QueuedInput => ({
  text: `${previous.text}\n${next.text}`,
  images: [...previous.images, ...next.images],
})

export async function recallQueued(
  api: QueueApi,
  conversationId: ConversationId,
  items: readonly InboxItem[],
): Promise<QueuedInput[]> {
  const steersBeforeFollowUps = [
    ...items.filter((item) => item.mode === 'steer'),
    ...items.filter((item) => item.mode === 'followUp'),
  ]
  const recovered = await Promise.all(
    steersBeforeFollowUps.map(async (item) => {
      try {
        await api.cancelSubmission(item.id, conversationId)
      } catch (failure) {
        if (takenByRunBeforeWithdrawal(failure)) return undefined
        throw failure
      }
      return queuedInput(item)
    }),
  )
  return recovered.filter((input) => input !== undefined)
}

export const recalledText = (current: string, recalled: readonly QueuedInput[]) =>
  [current, ...recalled.map((input) => input.text)].filter((text) => text.trim()).join('\n\n')
