import type { ExtensionHost } from '../server/extensions.ts'

type Host = Pick<ExtensionHost, 'harness' | 'resource'>

const holders = (host: Host) => {
  const byHarness = host.resource('harness.holds', () => new WeakMap<object, Set<string>>())
  const harness = host.harness()
  if (!byHarness.has(harness)) byHarness.set(harness, new Set())
  return byHarness.get(harness)!
}

// Pi upstream: @earendil-works/pi-durable@1.6.0 — patched Harness.hold()/release() keep the scheduler from starting tasks.
export function hold(host: Host, holder: string) {
  holders(host).add(holder)
  host.harness().hold()
}

export function release(host: Host, holder: string) {
  const held = holders(host)
  held.delete(holder)
  if (!held.size) host.harness().release()
}
