import type { EventBus } from '@earendil-works/pi-coding-agent'
import { useEffect, useRef } from 'react'

// Pi upstream: @earendil-works/pi-coding-agent@1.5.2 src/core/event-bus.ts — adapted: Pi's bus uses node:events; use browser-safe sets. Drop when Pi ships a browser-safe bus.
const channels = new Map<string, Set<(data: unknown) => Promise<void>>>()
export const events: EventBus = {
  emit: (channel, data) => {
    // oxlint-disable-next-line unicorn/no-useless-spread, typescript/no-floating-promises -- snapshot listeners; on wraps each handler with a catch that logs failures.
    for (const handler of [...(channels.get(channel) ?? [])]) void handler(data)
  },
  on: (channel, handler) => {
    const safe = async (data: unknown) => {
      try {
        // oxlint-disable-next-line typescript/await-thenable -- Pi's void-returning type also permits async handlers
        await handler(data)
      } catch (error) {
        console.error(`Event handler error (${channel}):`, error)
      }
    }
    if (!channels.has(channel)) channels.set(channel, new Set())
    channels.get(channel)!.add(safe)
    return () => {
      const handlers = channels.get(channel)
      handlers?.delete(safe)
      if (!handlers?.size) channels.delete(channel)
    }
  },
}

/** Subscribe for this mount, always calling the latest handler. */
export function useEvent(channel: string, handler: (data: unknown) => void) {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => events.on(channel, (data) => latest.current(data)), [channel])
}
