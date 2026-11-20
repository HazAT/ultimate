/**
 * The sidebar's conversation filter: a row matches when every word of the query appears in its title, `#id` or
 * feature tag, ignoring case and accents (`paie` finds `Paie`, `ete` finds `Été`). A title's `PR #2287` matches `#2287`
 * too, as the header's pull request chip comes from it. Browser-safe.
 */
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

export function conversationFilter(query: string) {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (!words.length) return undefined
  return (conversation: { id: number; title?: string }, feature?: string) => {
    const text = fold(`${conversation.title ?? ''} #${conversation.id} ${feature ?? ''}`)
    return words.every((word) => text.includes(word))
  }
}
