import { parseConversationId, parseEntryId } from '../../../../lib/ids.ts'
/**
 * `#157029` and `#157029/158003` in running text: a conversation, and an entry in it. Never part of a word, a path, a
 * URL fragment or an HTML entity; ids under three digits stay text, since `#1 priority` or `#12` is usually not a
 * conversation.
 */
export const mentionPattern = /(?<![\w/#&])#(\d{3,})(?:\/(\d+))?(?![\w/])/g

/**
 * The link a mention becomes in Markdown; the conversations extension's `link` renderer turns it into a chip. A bare
 * fragment, since Streamdown's hardening blocks other relative links, and no other link renderer reads one.
 */
export const mentionHref = (conversation: string, entry?: string) =>
  `#conversation-${conversation}${entry ? `-${entry}` : ''}`

/** A mention link's conversation and entry, or undefined for any other href. */
export function parseMention(href: string) {
  const match = /^#conversation-(\d+)(?:-(\d+))?$/.exec(href)
  return match
    ? {
        conversation: parseConversationId(Number(match[1])),
        entry: match[2] ? parseEntryId(Number(match[2])) : undefined,
      }
    : undefined
}

/** Splits text into strings and mentions, in order. */
export function splitMentions(text: string) {
  const parts: (string | { conversation: string; entry?: string; text: string })[] = []
  let last = 0
  for (const match of text.matchAll(mentionPattern)) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    parts.push({ conversation: match[1], entry: match[2], text: match[0] })
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

type Node = { type: string; value?: string; children?: Node[]; url?: string }

/**
 * Remark plugin: mentions in text become links to `mentionHref`. Code, inline code and existing links keep their text,
 * since only plain `text` nodes outside links are rewritten.
 */
export function remarkMentions() {
  const visit = (node: Node) => {
    if (!node.children || node.type === 'link' || node.type === 'linkReference') return
    node.children = node.children.flatMap((child) => {
      if (child.type !== 'text' || !child.value?.includes('#')) {
        visit(child)
        return [child]
      }
      return splitMentions(child.value).map((part) =>
        typeof part === 'string'
          ? { type: 'text', value: part }
          : {
              type: 'link',
              url: mentionHref(part.conversation, part.entry),
              children: [{ type: 'text', value: part.text }],
            },
      )
    })
  }
  return visit
}
