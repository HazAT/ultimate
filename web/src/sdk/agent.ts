import { createAgent } from '@ui-sdk/core/agent'

/** The page's ui-sdk agent bridge: `snapshot`, `query`, `act`, and `subscribe` to every component change. */
export type UiAgent = ReturnType<typeof createAgent>
export type { ObservedChange } from '@ui-sdk/core/agent'

export function createUiAgent(driven: boolean) {
  let bridge: UiAgent | undefined
  return {
    driven,
    bridge: () => (bridge ??= createAgent()),
  }
}
export type UiAgentHandle = ReturnType<typeof createUiAgent>
