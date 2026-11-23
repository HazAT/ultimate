export const mentionPattern = /(?<![\w/#&])#(\d{3,})(?:\/(\d+))?(?![\w/])/g

const notAConversation = /\b(?:PR|pull request|issue)\s*$/i

export function mentionedConversations(text: string) {
  const ids = new Set<number>()
  for (const match of text.matchAll(mentionPattern))
    if (!notAConversation.test(text.slice(0, match.index))) ids.add(Number(match[1]))
  return [...ids]
}
