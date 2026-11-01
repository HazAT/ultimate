import type { EntryRecord } from '@earendil-works/pi-durable'
import type { Turn } from './refs.ts'

/** The most of a turn's text the line carries: more than two lines of the widest transcript hold. */
const LIMIT = 280

/** The user's words in `entry`: an input they typed, or a message they sent; undefined for any other entry. */
function turnText(entry: EntryRecord): string | undefined {
  const message = entry.model?.[0]
  if (entry.kind === 'pi.user' && message?.role === 'user')
    return typeof message.content === 'string'
      ? message.content
      : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
  const data = entry.data as { from?: unknown; text?: unknown } | undefined
  if ((entry.kind === 'board.message' || entry.kind === 'board.reply') && data?.from === 'user')
    return typeof data.text === 'string' ? data.text : ''
  return undefined
}

/** `text` on one line, cut with an ellipsis past `LIMIT` characters. */
function oneLine(text: string) {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > LIMIT ? `${line.slice(0, LIMIT - 1).trimEnd()}…` : line
}

/**
 * A message reference at the start of `text`, as the codemode extension writes it (`Ultimate conversation #1, message
 * #2. Read it in codemode with …`), and the user's words after it.
 */
function reference(text: string) {
  const match =
    /^Ultimate conversation #(\d+), message #(\d+)\. Read it in codemode with [^\n]*?\)\.(?:\s+—)?/.exec(
      text,
    )
  return match
    ? {
        reference: { conversation: Number(match[1]), entry: Number(match[2]) },
        rest: text.slice(match[0].length),
      }
    : { rest: text }
}

/**
 * The line that names `entry` when it is a turn of the user's, undefined otherwise: a `/skill` input as typed, a leading
 * message reference apart, and the words as the user wrote them.
 */
export function turnLine(entry: EntryRecord): Turn | undefined {
  const text = turnText(entry)
  if (text === undefined) return undefined
  const skill = /^<skill name="([^"]+)"[^>]*>\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]*))?$/.exec(text)
  if (skill)
    return { entryId: entry.id, skill: `/skill:${skill[1]}`, text: oneLine(skill[2] ?? '') }
  const { reference: ref, rest } = reference(text.trim())
  const words = oneLine(rest)
  return {
    entryId: entry.id,
    ...(ref && { reference: ref }),
    text: words || (ref ? '' : 'Your message'),
  }
}
