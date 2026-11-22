import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import type { UpdateState } from '../../refs.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  actions: [] as { name: string; args: unknown; source: string | null }[],
  requests: [] as { path: string; source: string | null }[],
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
    const source = new Headers(init?.headers).get('x-ultimate-source')
    if (init?.method === 'POST' && !path.startsWith('/api/events/')) {
      harness.requests.push({ path, source })
    }
    if (path === '/api/restart') return Response.json({ generation: 2 })
    const action = /^\/api\/extensions\/update\/actions\/(\w+)$/.exec(path)
    if (!action) return server.handle(path, init) ?? Response.json({ ok: true })
    const { args } = JSON.parse(init!.body as string) as { args: unknown }
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
  const { answerReadsWith } = await import('../../../../test/web/fake-source.ts')
  const pageFetch = answerReadsWith(fetch)
  const store = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch: pageFetch,
  })
  const api = createApi(store, { fetch: pageFetch })
  return {
    store,
    api,
    reads: createReads(api, store),
    registry: createRegistry(),
    uiState: createUiState(undefined),
  }
})

import { ROOT } from '../../../../web/src/sdk/api.ts'
import { reads, store } from '../../../../web/src/sdk/client.ts'
import { Chip } from '../../chip.solid.tsx'
import { StateAction } from '../../refs.ts'

const base = harness.state
let approved = false
const agent = createAgent({ allow: (step) => !step.confirm || approved })
beforeEach(() => {
  vi.useFakeTimers()
  harness.requests.length = 0
  harness.actions.length = 0
  harness.sources.length = 0
  approved = false
  store.start()
  harness.sources[0].open()
})
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

async function mountChip(state: Partial<UpdateState> = {}) {
  harness.state = { ...base, ...state }
  await reads.get(StateAction.extension, StateAction.name, null, ROOT).refetch()
  const container = renderSolid(() => <Chip />)
  await vi.advanceTimersByTimeAsync(10)
  flush()
  expect(
    await act({ ref: 'Updates to the Ultimate clone', action: 'setOpen', args: [true] }),
  ).toMatchObject({ ok: true })
  await expectDistinctAgentNames(agent)
  return container
}

async function expectApproval(button: string, path: string) {
  const requests = () => harness.requests.filter((call) => call.path === path)
  const press = () => act({ ref: button, action: 'press' })
  expect(await press()).toMatchObject({ ok: false })
  expect(requests()).toEqual([])
  approved = true
  expect(await press()).toMatchObject({ ok: true })
  return requests()
}

it('lets an agent open the update popover and update the clone once a person approves', async () => {
  const container = await mountChip()
  expect(container.querySelector('[data-update]')?.textContent).toBe('1 new · update')
  expect(container.querySelector('[data-update-now]')).not.toBeNull()
  const path = '/api/extensions/update/actions/update'
  expect(await expectApproval('Update now', path)).toEqual([{ path, source: 'agent' }])
  expect(harness.actions).toContainEqual({ name: 'update', args: null, source: 'agent' })
  expect(container.textContent).toContain('Updated a1..b2 · 1 commit')
})

it('retries pnpm install for an agent only once a person approves', async () => {
  await mountChip({ behind: 0, commits: [], install: true })
  const path = '/api/extensions/update/actions/update'
  expect(await expectApproval('Retry pnpm install', path)).toEqual([{ path, source: 'agent' }])
})

it('asks @ultimate to merge for an agent only once a person approves', async () => {
  await mountChip({ refused: 'diverged', merge: true, ahead: 1 })
  const path = '/api/extensions/update/actions/merge'
  expect(await expectApproval('Update with @ultimate', path)).toEqual([{ path, source: 'agent' }])
})

it('restarts for an agent only once a person approves', async () => {
  await mountChip({ behind: 0, commits: [], restart: true })
  const path = '/api/restart'
  expect(await expectApproval('Restart now', path)).toEqual([{ path, source: 'agent' }])
})
