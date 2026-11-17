import { waiting } from '../questions/ui.tsx'
import type { Message } from '../messages/refs.ts'
import type { InboxItem } from './ui.tsx'

export type Entry = { key: string; at: number } & (
  | { message: Message; item?: undefined }
  | { item: InboxItem; message?: undefined }
)

export const messageKey = (id: number) => `message:${id}`

export function keyOf(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? messageKey(value) : undefined
  if (typeof value !== 'string' || !value) return undefined
  return /^\d+$/.test(value) ? messageKey(Number(value)) : value
}

export const inboxItems = (
  messages: readonly Message[],
  provided: readonly (readonly InboxItem[])[] = [],
): Entry[] =>
  [
    ...waiting(messages).map((message) => ({
      key: messageKey(message.id),
      at: message.at,
      message,
    })),
    ...provided.flat().map((item) => ({ key: item.key, at: item.at, item })),
  ].toSorted((a, b) => a.at - b.at)

export function selection(
  entries: readonly { key: string }[],
  selected: string | null,
  index: number,
) {
  if (selected !== null && entries.some((entry) => entry.key === selected)) return selected
  return entries[Math.min(Math.max(index, 0), entries.length - 1)]?.key
}

export const previewUrl = (text: string) =>
  /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/[^\s)<>\]`*]*)?/.exec(text)?.[0]

export function lead(text: string) {
  const trimmed = text.trimStart()
  const bold = /^\*\*(.+?)\*\*[:.]?\s*/.exec(trimmed)
  if (bold) return { title: bold[1].trim(), body: trimmed.slice(bold[0].length) }
  const [first = '', ...rest] = trimmed.split('\n')
  return {
    title: first
      .replace(/^[#>\-*\s]+/, '')
      .replace(/[*_`]/g, '')
      .trim(),
    body: rest.join('\n').trim(),
  }
}

export function answeredToday(messages: readonly Message[], now: number) {
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  return messages
    .filter((m) => m.to === 'user' && (m.state === 'answered' || m.state === 'dismissed'))
    .flatMap((m) => {
      const reply = messages.find((r) => r.from === 'user' && r.re === m.id)
      return reply && reply.at >= midnight ? [{ message: m, at: reply.at }] : []
    })
    .toSorted((a, b) => b.at - a.at)
}
