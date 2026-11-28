import type { Harness } from '@earendil-works/pi-durable'

const holders = ((globalThis as Record<symbol, unknown>)[Symbol.for('ultimate.harness-holds')] ??=
  new WeakMap()) as WeakMap<Harness, Set<string>>

// Pi upstream: @earendil-works/pi-durable@1.6.0 — patched Harness.hold()/release() keep the scheduler from starting tasks.
export function hold(harness: Harness, holder: string) {
  const held = holders.get(harness) ?? new Set<string>()
  holders.set(harness, held)
  held.add(holder)
  harness.hold()
}

export function release(harness: Harness, holder: string) {
  const held = holders.get(harness)
  held?.delete(holder)
  if (!held?.size) harness.release()
}
