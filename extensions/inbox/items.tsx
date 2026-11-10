/** What the Inbox lists and how its selection moves: pure, over the Messages log. */
import { waiting } from '../questions/ui.tsx'
import type { Message } from '../messages/refs.ts'

/** Every message that waits on the user, oldest first: the Inbox's items. */
export const inboxItems = (messages: readonly Message[]) => waiting(messages).toReversed()

/**
 * The item to show: `selected` while it still waits, else the one that took its place (`index`, where it was), so
 * answering an item moves on to the next oldest; the newest when it was the last. None on an empty Inbox.
 */
export function selection(
  items: readonly { id: number }[],
  selected: number | null,
  index: number,
) {
  if (selected !== null && items.some((item) => item.id === selected)) return selected
  return items[Math.min(Math.max(index, 0), items.length - 1)]?.id
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
