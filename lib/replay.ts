/**
 * Tool replay declarations (`ultimate/replay-safe-by-name`). After a crash Pi Durable reruns an interrupted call only
 * when its tool is replay-safe; these say why a rerun cannot do harm, so the reason is code, not a comment.
 */

/** Spread into a tool that only reads: a rerun changes nothing. */
export const readOnly = { replay: 'safe' } as const

/** Spread into a tool that writes, where a rerun does no harm; `why` says what makes it so (a receipt, a memo, …). */
export const safeToRerun = (why: string) => {
  if (!why.trim()) throw new Error('safeToRerun needs why a rerun does no harm')
  return { replay: 'safe' } as const
}
