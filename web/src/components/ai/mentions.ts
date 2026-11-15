import { parseConversationId, parseEntryId } from '../../../../lib/ids.ts'
export const mentionPattern = /(?<![\w/#&])#(\d{3,})(?:\/(\d+))?(?![\w/])/g

export const mentionHref = (conversation: string, entry?: string) =>
  `#conversation-${conversation}${entry ? `-${entry}` : ''}`

export function parseMention(href: string) {
  const match = /^#conversation-(\d+)(?:-(\d+))?$/.exec(href)
  return match
    ? {
        conversation: parseConversationId(Number(match[1])),
        entry: match[2] ? parseEntryId(Number(match[2])) : undefined,
      }
    : undefined
}

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

export function remarkMentions() {
  const visit = (node: Node) => {
    const preservesExistingLink = () => node.type === 'link' || node.type === 'linkReference'
    if (!node.children || preservesExistingLink()) return
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
