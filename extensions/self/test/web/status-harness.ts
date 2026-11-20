import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import type { SystemInfo } from '../../../../shared/protocol.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  restart: vi.fn<(source: string | null) => Response>(),
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) =>
    input === '/api/restart'
      ? harness.restart(new Headers(init?.headers).get('x-ultimate-source'))
      : (harness.server?.handle(input as string, init) ?? Response.json({ ok: true }))
  const store = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch,
  })
  return {
    store,
    api: createApi(store, { fetch }),
    uiState: createUiState(undefined),
    registry: createRegistry(),
    bundle: 'browser-build',
    switched: undefined,
  }
})

import { store } from '../../../../web/src/sdk/client.ts'

export const approval = { given: true }
export const agent = createAgent({ allow: (step) => !step.confirm || approval.given })
export const restart = harness.restart
harness.server = fakeSubscriptions(harness.sources)
export const tick = async (ms = 10) => {
  await vi.advanceTimersByTimeAsync(ms)
  flush()
}
export function system({
  coreStale = false,
  left,
}: { coreStale?: boolean; left?: SystemInfo['web']['left'] } = {}) {
  const root = '/projects/ultimate'
  const at = '2026-01-01T00:00:00Z'
  harness.sources[0].send('system', {
    code: { ultimateRoot: root, branch: 'main', sha: 'abc1234new', dirty: false, coreStale },
    process: { pid: 100, node: 'v26', startedAt: at, generation: 3, url: 'http://localhost' },
    web: { id: 'browser-build', changed: [], left },
    build: {
      id: 'abc1234new',
      at,
      generation: 3,
      changed: [],
      core: 'core-long-hash',
      lib: 'lib-long-hash',
      extensions: { self: 'self-long-hash' },
      history: [],
    },
    machine: {
      hostname: 'test-host',
      home: '/home/user',
      platform: 'linux',
      release: 'test',
      arch: 'x64',
      cpuModel: 'test',
      cpuCount: 1,
      totalMemory: 0,
      freeMemory: 0,
      user: 'user',
    },
    access: { origins: [] },
    persistence: { kind: 'sqlite', path: ':memory:', sizeBytes: 0, walBytes: 0 },
    execution: { kind: 'node-local', defaultCwd: root },
    project: { root, name: 'ultimate', config: false, decision: null, settings: {} },
    extensionDiagnostics: [],
    extensions: [],
    skills: [],
    skillDiagnostics: [],
    contextFiles: [],
  })
  flush()
}
export async function act(label: string, action: string, args?: unknown[], ok = true) {
  const entry = agent
    .snapshot()
    .find((item) => !item.offPage && item.label === label && item.actions.includes(action))
  expect(entry).toBeDefined()
  const result = agent.act({ steps: [{ ref: entry!.ref, action, args }] })
  await tick(100)
  expect(await result).toMatchObject({ ok })
}

beforeEach(async () => {
  vi.useFakeTimers()
  harness.sources.length = 0
  approval.given = true
  harness.restart.mockReset()
  store.start()
  harness.sources[0].open()
  await tick()
})
afterEach(() => {
  store.stop()
  vi.useRealTimers()
})
