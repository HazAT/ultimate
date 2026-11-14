/**
 * Tool replay declarations (`ultimate/replay-safe-by-name`). After a crash Pi Durable reruns an interrupted call only
 * when its tool is replay-safe; these say why a rerun cannot do harm, so the reason is code, not a comment.
 */

/** Spread into a tool that only reads: a rerun changes nothing. */
export const readOnly = { replay: 'safe' } as const

/** Spread into a tool that writes but makes a rerun a no-op; `how` names what deduplicates it. */
export const dedupedBy = (how: string) => {
  if (!how.trim()) throw new Error('dedupedBy needs what deduplicates the rerun')
  return { replay: 'safe' } as const
}
