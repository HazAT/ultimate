/** The excerpt split at each match, so the surface marks what the search matched. */
export type Piece = { text: string; hit: boolean }

/** Splits `excerpt` at every occurrence of `query`, case-sensitive as the search matched it; no query leaves it whole. */
export function highlight(excerpt: string, query: string): Piece[] {
  if (!query) return excerpt ? [{ text: excerpt, hit: false }] : []
  const pieces: Piece[] = []
  let from = 0
  for (;;) {
    const at = excerpt.indexOf(query, from)
    if (at < 0) break
    if (at > from) pieces.push({ text: excerpt.slice(from, at), hit: false })
    pieces.push({ text: query, hit: true })
    from = at + query.length
  }
  const rest = excerpt.slice(from)
  if (rest) pieces.push({ text: rest, hit: false })
  if (pieces.length === 0) pieces.push({ text: excerpt, hit: false })
  return pieces
}
