import { flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ExtensionName } from '@/sdk/solid'
import { EVENT_FEED } from '../../../../shared/events.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  played: [] as string[],
  hits: [] as unknown[],
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const store = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch: async (path, init) =>
      harness.server?.handle(path as string, init) ?? Response.json({ ok: true }),
  })
  return { store, uiState: createUiState(undefined), api: {}, registry: createRegistry() }
})
vi.mock('../../tones.ts', () => ({
  setVolume: () => undefined,
  play: async (sound: string) => void harness.played.push(sound),
  say: async () => undefined,
}))
vi.mock('../../conductor.ts', () => ({
  conduct: async () => undefined,
  hit: (happening: unknown) => void harness.hits.push(happening),
}))

import { store, uiState } from '../../../../web/src/sdk/client.ts'
import { Player } from '../../player.solid.tsx'

harness.server = fakeSubscriptions(harness.sources)
const tick = () => vi.advanceTimersByTimeAsync(10)
const root = () => harness.server!.of(1)!
const agent = 7
const question = { id: 3, from: agent, to: 'user', text: 'Ship it?', reply: true }

beforeEach(async () => {
  vi.stubGlobal('navigator', {
    userActivation: { hasBeenActive: true },
    locks: { request: async (_key: string, run: () => unknown) => run() },
  })
  vi.useFakeTimers()
  harness.sources.length = 0
  harness.server!.subscriptions.length = 0
  harness.played.length = 0
  harness.hits.length = 0
  store.start()
  harness.sources[0].open()
  await tick()
})
afterEach(() => {
  store.stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
})

it('plays the question cue once when @ultimate asks the user something new', async () => {
  uiState.receive({})
  renderSolid(() => (
    <ExtensionName value="sounds">
      <Player />
    </ExtensionName>
  ))
  flush()
  await tick()
  const board = (messages: (typeof question)[]) =>
    root().send('doc', { kind: 'board', value: { messages, next: 4 } })
  root().send('doc', { kind: 'ultimate.standing-agents', value: { ultimate: agent } })
  root().send('doc', { kind: 'ultimate.conversation-overview', value: { conversations: {} } })
  root().send('doc', { kind: EVENT_FEED, value: { events: [] } })
  board([])
  flush()
  await tick()
  expect(harness.played).toEqual([])

  board([question])
  flush()
  await tick()
  board([question])
  flush()
  await tick()
  expect(harness.played).toEqual(['input'])
})

it('plays the finished cue when only the run state of @ultimate’s existing row changes', async () => {
  uiState.receive({})
  renderSolid(() => (
    <ExtensionName value="sounds">
      <Player />
    </ExtensionName>
  ))
  flush()
  await tick()
  root().send('doc', { kind: 'ultimate.standing-agents', value: { ultimate: agent } })
  root().send('doc', { kind: EVENT_FEED, value: { events: [] } })
  root().send('doc', { kind: 'board', value: { messages: [], next: 1 } })
  root().send('doc', {
    kind: 'ultimate.conversation-overview',
    value: { conversations: { [agent]: { runState: 'working', inputId: 9 } } },
  })
  flush()
  await tick()
  root().send('docOps', {
    kind: 'ultimate.conversation-overview',
    ops: [
      ['s', ['conversations', String(agent), 'runState'], 'answered'],
      ['s', ['conversations', String(agent), 'answerId'], 10],
    ],
  })
  flush()
  await tick()
  expect(harness.played).toEqual(['finished'])
})

it('plays a busy worker’s new tool call in the sound of agents, once', async () => {
  uiState.receive({ 'ext.sounds.agents': 'chiptune' })
  const worker = 12
  const conversation = { id: worker, label: 'worker', busy: true, title: 'Fix', updatedAt: 0 }
  renderSolid(() => (
    <ExtensionName value="sounds">
      <Player />
    </ExtensionName>
  ))
  flush()
  await tick()
  root().send('doc', { kind: 'ultimate.standing-agents', value: { ultimate: agent } })
  root().send('doc', { kind: 'ultimate.conversation-overview', value: { conversations: {} } })
  root().send('doc', { kind: EVENT_FEED, value: { events: [] } })
  harness.sources[0].send('conversations', [conversation] as never)
  flush()
  await tick()
  const live = (tools: object[]) =>
    harness.server!.of(worker)!.send('doc', { kind: 'pi.live', value: { tools } as never })
  live([])
  flush()
  await tick()
  vi.advanceTimersByTime(5000)
  live([{ callId: 'a', name: 'bash' }])
  flush()
  await tick()
  live([{ callId: 'a', name: 'bash' }])
  flush()
  await tick()
  const check = (id: number, result: string) => ({
    id,
    kind: 'event.workspaces.check',
    name: 'workspaces.check',
    v: 1,
    at: '',
    data: { submission: 's', command: 'pnpm test', result, ms: 1 },
  })
  root().send('doc', {
    kind: EVENT_FEED,
    value: { events: [check(20, 'passed'), check(21, 'failed')] },
  })
  flush()
  await tick()
  expect(harness.hits).toEqual([{ kind: 'tool', role: 'worker', tool: 'bash' }, { kind: 'failed' }])
})
