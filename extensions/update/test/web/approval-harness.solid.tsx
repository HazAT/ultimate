/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterEach, expect, vi } from 'vitest'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import type { UpdateState } from '../../refs.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  actions: [] as { name: string; args: unknown; source: string | null }[],
  requests: [] as { path: string; source: string | null }[],
  base: undefined as unknown as UpdateState,
  state: {
    root: '/home/user/ultimate',
    branch: 'main',
    behind: 1,
    commits: [{ sha: 'b2', subject: 'Reload the web' }],
    layers: { live: true, core: false, lockfile: false, bin: false },
    install: false,
    restart: false,
  } as UpdateState,
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const server = fakeSubscriptions(harness.sources)
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    if (init?.method === 'POST' && !path.startsWith('/api/events/'))
      harness.requests.push({ path, source: new Headers(init.headers).get('x-ultimate-source') })
    if (path === '/api/restart') return Response.json({ generation: 2 })
    const action = /^\/api\/extensions\/update\/actions\/(\w+)$/.exec(path)
    if (!action) return server.handle(path, init) ?? Response.json({ ok: true })
    const { args } = JSON.parse(init!.body as string) as { args: unknown }
    const source = new Headers(init!.headers).get('x-ultimate-source')
    harness.actions.push({ name: action[1], args, source })
    if (action[1] === 'merge') return Response.json({ result: { id: 9 } })
    if (action[1] === 'update' && !harness.state.install) {
      const updated = {
        ok: true,
        from: 'a1',
        to: 'b2',
        commits: 1,
        layers: harness.state.layers!,
        install: 'skipped',
      } as const
      harness.state = { ...harness.state, behind: 0, commits: [], updated }
      return Response.json({ result: updated })
    }
    return Response.json({ result: harness.state })
  }
  const store = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch,
  })
  const api = createApi(store, { fetch })
  return {
    store,
    api,
    reads: createReads(api, store),
    registry: createRegistry(),
    uiState: createUiState(undefined),
  }
})

import { store } from '../../../../web/src/sdk/client.ts'
import { Chip } from '../../chip.solid.tsx'

harness.base = harness.state
const approval = { given: false }
const agent = createAgent({ allow: (step) => !step.confirm || approval.given })
afterEach(() => {
  store.stop()
  vi.useRealTimers()
})

async function act(step: Parameters<typeof agent.act>[0]['steps'][number]) {
  const result = agent.act({ steps: [step] })
  await vi.advanceTimersByTimeAsync(100)
  flush()
  return result
}

export async function expectApproval(button: string, state: Partial<UpdateState>, request: string) {
  approval.given = false
  harness.state = { ...harness.base, ...state }
  vi.useFakeTimers()
  store.start()
  harness.sources.at(-1)!.open()
  renderSolid(() => <Chip />)
  await vi.advanceTimersByTimeAsync(10)
  flush()
  const trigger = agent.snapshot().find((entry) => entry.label === 'Updates to the Ultimate clone')
  await act({ ref: trigger!.ref, action: 'setOpen', args: [true] })
  const control = agent.snapshot().find((entry) => !entry.offPage && entry.label === button)
  expect(await act({ ref: control!.ref, action: 'press' })).toMatchObject({ ok: false })
  expect(harness.requests.filter((call) => call.path === request)).toEqual([])
  approval.given = true
  await act({ ref: control!.ref, action: 'press' })
  return harness.requests.filter((call) => call.path === request)
}
