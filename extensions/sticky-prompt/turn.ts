import type { EntryRecord } from '@earendil-works/pi-durable'

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

/** The first phrase of `text`, with an ellipsis when it goes on; a list marker such as `1a.` is no phrase. */
export function firstPhrase(text: string) {
  const body = text.trim()
  const phrase = /^(?:[^\n]{4}[\s\S]*?|[\s\S]*?)(?:[.!?](?=\s)|\n|$)/.exec(body)![0].trim()
  return phrase.length < body.length ? `${phrase.replace(/[.!?]$/, '')}…` : phrase
}

/**
 * The line that names `entry` when it is a turn of the user's, undefined otherwise. A `/skill` input names its request,
 * or the skill when it has none.
 */
export function turnPhrase(entry: EntryRecord): string | undefined {
  const text = turnText(entry)
  if (text === undefined) return undefined
  const skill = /^<skill name="([^"]+)"[^>]*>\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]*))?$/.exec(text)
  return firstPhrase(skill ? skill[2] || `/${skill[1]}` : text) || 'Your message'
}
