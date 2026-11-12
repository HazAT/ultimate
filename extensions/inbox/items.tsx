/** What the Inbox lists and how its selection moves: pure, over the Messages log and the provided items. */
import { waiting } from '../questions/ui.tsx'
import type { Message } from '../messages/refs.ts'
import type { InboxItem } from './ui.tsx'

/** One row of the Inbox: a question to the user (`message`) or another extension's item (`item`). */
export type Entry = { key: string; at: number } & (
  | { message: Message; item?: undefined }
  | { item: InboxItem; message?: undefined }
)

/** A question's key; a provided item keeps its own. */
export const messageKey = (id: number) => `message:${id}`

/**
 * What `?inbox=` or `inbox:open` names: a plain number is a message id (older push links), anything else an item's
 * key.
 */
export function keyOf(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? messageKey(value) : undefined
  if (typeof value !== 'string' || !value) return undefined
  return /^\d+$/.test(value) ? messageKey(Number(value)) : value
}

/** Every message that waits on the user and every provided item, oldest first: the Inbox's entries. */
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

/**
 * The entry to show: `selected` while it still waits, else the one that took its place (`index`, where it was), so
 * answering an entry moves on to the next oldest; the newest when it was the last. None on an empty Inbox.
 */
export function selection(
  entries: readonly { key: string }[],
  selected: string | null,
  index: number,
) {
  if (selected !== null && entries.some((entry) => entry.key === selected)) return selected
  return entries[Math.min(Math.max(index, 0), entries.length - 1)]?.key
}

/** A local preview the text links to (`http://127.0.0.1:…` or `localhost`), which makes the item a preview. */
export const previewUrl = (text: string) =>
  /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/[^\s)<>\]`*]*)?/.exec(text)?.[0]

/**
 * A message split into its title and the rest: a bold lead (`**Title** …`) or else its first line, without Markdown
 * marks; the body keeps what follows, so the reading pane does not say the title twice.
 */
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

/** The user's questions settled today (answered or dismissed), newest first, with when they replied. */
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
