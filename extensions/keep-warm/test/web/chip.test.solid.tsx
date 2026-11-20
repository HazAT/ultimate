/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { parseConversationId } from '../../../../lib/ids.ts'
import type { WarmState } from '../../refs.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  actions: [] as { name: string; args: unknown; source?: string | null }[],
  state: undefined as WarmState | undefined,
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    const action = /^\/api\/extensions\/keep-warm\/actions\/(\w+)$/.exec(path)
    if (!action) return harness.server?.handle(path, init) ?? Response.json({ ok: true })
    const { args } = JSON.parse(init!.body as string) as { args: unknown }
    const source = new Headers(init!.headers).get('x-ultimate-source')
    harness.actions.push({ name: action[1], args, source })
    if (action[1] === 'set') {
      const { warm } = args as { warm?: boolean | null }
      if (warm !== undefined)
        harness.state = {
          ...harness.state!,
          warm:
            warm === null ? { value: true, source: 'agent' } : { value: warm, source: 'override' },
        }
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
  return { store, api, reads: createReads(api, store), uiState: createUiState(undefined) }
})

import { store } from '../../../../web/src/sdk/client.ts'
import { UltimateChip } from '../../chip.solid.tsx'

const ULTIMATE = 5
const agent = createAgent()
harness.server = fakeSubscriptions(harness.sources)
beforeEach(async () => {
  vi.useFakeTimers()
  harness.sources.length = 0
  harness.actions.length = 0
  harness.state = {
    kind: 'standing',
    agent: 'ultimate',
    warm: { value: true, source: 'agent' },
    compact: { value: false, source: 'default' },
    minutes: { value: 480, source: 'agent' },
    compactTokens: { value: 150_000, source: 'default' },
    provider: 'claude-code',
    model: 'claude-opus-5-5',
    ttl: 3_600_000,
    pingAfter: 3_240_000,
    rewriteCost: 0.24,
    warmCost: { pings: 8, cost: 0.048 },
    lastAt: Date.now(),
    tokens: 30_000,
    next: { at: Date.now() + 3_240_000, step: 'ping' },
    pings: 0,
  }
  store.start()
  harness.sources[0].open()
  await vi.advanceTimersByTimeAsync(10)
})
afterEach(() => {
  store.stop()
  vi.useRealTimers()
})

async function act(steps: Parameters<typeof agent.act>[0]['steps']) {
  const result = agent.act({ steps })
  await vi.advanceTimersByTimeAsync(100)
  flush()
  return result
}

async function mountChip() {
  const container = renderSolid(() => <UltimateChip />)
  await vi.advanceTimersByTimeAsync(10)
  harness
    .server!.of(1)!
    .send('doc', { kind: 'ultimate.standing-agents', value: { ultimate: ULTIMATE } })
  await vi.advanceTimersByTimeAsync(10)
  flush()
  return container
}

it('shows the warm chip, opens its popover, and sends a person’s click as theirs', async () => {
  const container = await mountChip()
  const trigger = container.querySelector<HTMLButtonElement>(
    `button[aria-label="@ultimate's prompt cache"]`,
  )
  expect(trigger?.textContent).toBe('@ultimate')
  expect(trigger?.dataset.keepWarm).toBe('warm')
  trigger!.click()
  flush()
  expect(trigger!.hasAttribute('data-open')).toBe(true)
  expect(container.textContent).toContain('Keep @ultimate warm')
  expect(container.textContent).toContain('Writing it again costs ≈ $0.240')
  expect(container.textContent).toContain('≈ $0.048 for 8 pings, one every 54 min')
  container.querySelector<HTMLButtonElement>('[role="switch"]')!.click()
  await vi.advanceTimersByTimeAsync(10)
  expect(harness.actions).toContainEqual({
    name: 'set',
    args: { id: ULTIMATE, warm: false },
    source: 'person',
  })
})

it('stays on screen and actable while the page switches to another conversation', async () => {
  const container = await mountChip()
  const calls = harness.actions.length
  const chip = container.querySelector('[data-keep-warm]')
  const trigger = agent.snapshot().find((entry) => entry.label === "@ultimate's prompt cache")
  store.show(parseConversationId(42))
  flush()
  expect(container.querySelector('[data-keep-warm]')).toBe(chip)
  expect(await act([{ ref: trigger!.ref, action: 'setOpen', args: [true] }])).toMatchObject({
    ok: true,
  })
  await expectDistinctAgentNames(agent)
  expect(harness.actions.slice(calls)).toEqual([
    { name: 'state', args: { id: ULTIMATE }, source: 'person' },
  ])
})

it('lets an agent open the popover and turn keep-warm off for this chat through the server', async ({
  onTestFinished,
}) => {
  const container = await mountChip()
  const closed = agent.snapshot().filter((entry) => !entry.offPage)
  expect(closed.map((entry) => [entry.component, entry.label])).toEqual([
    ['popover', "@ultimate's prompt cache"],
  ])
  const changes = vi.fn<Parameters<typeof agent.subscribe>[0]>()
  onTestFinished(agent.subscribe(changes))

  const opened = await act([{ ref: closed[0].ref, action: 'setOpen', args: [true] }])
  expect(opened).toMatchObject({ ok: true })
  await expectDistinctAgentNames(agent)
  const toggle = agent
    .snapshot()
    .find((entry) => !entry.offPage && entry.label === 'Keep @ultimate warm')
  expect(toggle).toMatchObject({ component: 'switch', checked: true })

  const result = await act([{ ref: toggle!.ref, action: 'setChecked', args: [false] }])
  expect(result).toMatchObject({ ok: true })
  expect(harness.actions).toContainEqual({
    name: 'set',
    args: { id: ULTIMATE, warm: false },
    source: 'agent',
  })
  expect(changes).toHaveBeenCalledWith(
    expect.objectContaining({
      label: 'Keep @ultimate warm',
      key: 'checked',
      value: false,
      source: 'agent',
    }),
  )

  const statesBefore = harness.actions.filter((call) => call.name === 'state').length
  harness.server!.of(ULTIMATE)!.send('doc', { kind: 'keep-warm.state', value: { warm: false } })
  await vi.advanceTimersByTimeAsync(10)
  flush()
  expect(harness.actions.filter((call) => call.name === 'state')).toHaveLength(statesBefore + 1)
  const button = container.querySelector<HTMLButtonElement>('[data-keep-warm]')!
  expect(button.dataset.keepWarm).toBe('off')
  expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
  expect(container.querySelector('[data-source="override"]')?.classList.contains('invisible')).toBe(
    false,
  )
})
