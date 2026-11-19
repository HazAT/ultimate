import { createAgent } from '@ui-sdk/core/agent'

/** The page's ui-sdk agent bridge: `snapshot`, `query`, `act`, and `subscribe` to every component change. */
export type UiAgent = ReturnType<typeof createAgent>
export type { ObservedChange } from '@ui-sdk/core/agent'

/** Work that must reach the server before the page goes; `keepalive` is true when the page is being hidden. */
export type UiFlush = (keepalive: boolean) => Promise<unknown>

export function createUiAgent(driven: boolean) {
  let bridge: UiAgent | undefined
  const flushes = new Set<UiFlush>()
  return {
    driven,
    bridge: () => (bridge ??= createAgent()),
    onFlush(flush: UiFlush) {
      flushes.add(flush)
      return () => {
        flushes.delete(flush)
      }
    },
    async flush(keepalive: boolean) {
      const results = await Promise.allSettled([...flushes].map(async (flush) => flush(keepalive)))
      const failed = results.find((result) => result.status === 'rejected')
      if (failed) throw failed.reason
    },
  }
}
export type UiAgentHandle = ReturnType<typeof createUiAgent>
