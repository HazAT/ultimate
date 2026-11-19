import { resolve } from 'node:path'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { context } from '../server/harness.ts'
import { EventFeed } from '../server/events.ts'
import { ChangedEvent } from '../shared/events.ts'
import { UiState } from '../shared/ui-state.ts'
import { SOURCE_HEADER } from '../shared/protocol.ts'
import { fauxServer, removeTemp, temp } from './helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

async function serve(home?: string) {
  if (!home) {
    const made = await temp()
    cleanup.push(() => removeTemp(made))
    home = made
  }
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: home,
    userHome: home,
    home: `${home}/state`,
    port: 0,
  })
  let open = true
  const stop = async () => {
    if (open) await server.close()
    open = false
  }
  cleanup.push(stop)
  const send = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(server.url + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: server.url,
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0',
        ...headers,
      },
      body: JSON.stringify(body),
    })
  const post = async (path: string, body: unknown, headers?: Record<string, string>) => {
    const response = await send(path, body, headers)
    expect(response.status).toBe(200)
    return response.json() as Promise<unknown>
  }
  const changes = async () =>
    ((await server.harness.snapshot(EventFeed, ROOT_CONVERSATION_ID, context))?.events ?? [])
      .filter((event) => ChangedEvent.is(event))
      .map((event) => event.data)
  return { server, send, post, changes, home, stop }
}
const sets = (set: Record<string, unknown>) =>
  Object.entries(set).map(([key, value]) => ({ key, value }))
const deletes = (...keys: string[]) => keys.map((key) => ({ key }))

it('records each stored UI-state change in the commit that writes it, with who, from where and the device', async () => {
  const { server, send, post, changes } = await serve()
  const agent = { [SOURCE_HEADER]: 'agent' }
  await post('/api/ui', { ops: sets({ 'ext.digest.on': true, 'shell.panel': 'tasks' }) }, agent)
  await post('/api/ui', { ops: sets({ 'ext.digest.on': true }) })
  await post('/api/ui', {
    ops: [...sets({ 'ext.notes.text': 'x'.repeat(3000) }), ...deletes('ext.digest.on')],
  })
  await post('/api/ui', { ops: deletes('ext.never.set') })
  await post('/api/ui', { ops: sets({ 'ext.sidebar.seen': { 7: 1 } }) }, { [SOURCE_HEADER]: 'app' })
  const refused = await send('/api/ui', { ops: sets({ 'ext.huge': 'x'.repeat(300 * 1024) }) })
  expect(refused.status).toBe(413)

  const device = 'desktop firefox'
  expect(await changes()).toEqual([
    { key: 'ext.digest.on', value: true, source: 'agent', device },
    { key: 'ext.notes.text', value: '[value]', source: 'person', device },
    { key: 'ext.digest.on', previous: true, source: 'person', device },
  ])
  const state = await server.harness.snapshot(UiState, ROOT_CONVERSATION_ID, context)
  expect(state).toMatchObject({ 'shell.panel': 'tasks', 'ext.sidebar.seen': { 7: 1 }, 'ui.rev': 5 })
  expect(state).not.toHaveProperty('ext.huge')
})

it('keeps drafts out of the event history: only booleans, numbers and null are recorded as they are', async () => {
  const { server, post, changes } = await serve()
  const draft = { 'ext.questions.cards': { 42: { answer: 'my private answer', step: 2 } } }
  await post('/api/ui', { ops: sets({ 'ext.review.comment': 'a draft I never sent', ...draft }) })
  await post('/api/ui', {
    ops: sets({ 'ext.questions.cards': { 42: { step: 2, answer: 'my private answer' } } }),
  })
  await post('/api/ui', { ops: sets({ 'ext.count': 3, 'ext.picked': null }) })
  await post('/api/ui', { ops: deletes('ext.review.comment', 'ext.questions.cards') })

  const events = await changes()
  expect(JSON.stringify(events)).not.toContain('private')
  expect(JSON.stringify(events)).not.toContain('draft')
  const device = 'desktop firefox'
  expect(events).toEqual([
    { key: 'ext.review.comment', value: '[value]', source: 'person', device },
    { key: 'ext.questions.cards', value: '[value]', source: 'person', device },
    { key: 'ext.count', value: 3, source: 'person', device },
    { key: 'ext.picked', value: null, source: 'person', device },
    { key: 'ext.review.comment', previous: '[value]', source: 'person', device },
    { key: 'ext.questions.cards', previous: '[value]', source: 'person', device },
  ])
  const state = await server.harness.snapshot(UiState, ROOT_CONVERSATION_ID, context)
  expect(state).toMatchObject({ 'ext.count': 3 })
})

it('records keep-warm’s switch as a UI change in its own commit, by the agent only when the page says so', async () => {
  const { post, changes } = await serve()
  const set = (on: boolean, headers?: Record<string, string>) =>
    post('/api/extensions/keep-warm/actions/set', { args: { on } }, headers)
  await set(false, { [SOURCE_HEADER]: 'agent' })
  await set(false)
  await set(true)
  await set(false, { [SOURCE_HEADER]: 'app' })
  await set(true)
  expect(await changes()).toEqual([
    expect.objectContaining({ key: 'keep-warm.on', value: false, previous: true, source: 'agent' }),
    expect.objectContaining({
      key: 'keep-warm.on',
      value: true,
      previous: false,
      source: 'person',
    }),
    expect.objectContaining({ key: 'keep-warm.on', value: true, previous: false }),
  ])
})

it('applies ops in order and records each with its own writer, the header only the default', async () => {
  const { server, post, changes } = await serve()
  await post('/api/ui', { ops: sets({ 'ext.a': 1 }) }, { [SOURCE_HEADER]: 'app' })
  await post(
    '/api/ui',
    {
      ops: [
        { key: 'ext.a' },
        { key: 'ext.b', value: 2 },
        { key: 'ext.panel', value: 'mine', who: 'person' },
        { key: 'ext.panel', value: 'app', who: 'app' },
      ],
    },
    { [SOURCE_HEADER]: 'agent' },
  )
  const device = 'desktop firefox'
  expect(await changes()).toEqual([
    { key: 'ext.a', previous: 1, source: 'agent', device },
    { key: 'ext.b', value: 2, source: 'agent', device },
    { key: 'ext.panel', value: '[value]', source: 'person', device },
  ])
  const state = await server.harness.snapshot(UiState, ROOT_CONVERSATION_ID, context)
  expect(state).toEqual({ 'ext.b': 2, 'ext.panel': 'app', 'ui.rev': 2 })
})

const op = (key: string, value: string, seq: number) => ({ key, value, seq })

for (const exitFirst of [false, true])
  it(`applies a tab’s op to a key only when newer than its last one there, ${exitFirst ? 'the page-exit copy' : 'the original'} arriving first`, async () => {
    const { server, post, changes } = await serve()
    const original = { ops: [op('ext.panel', 'A', 1)], tab: 'tab-1' }
    const exit = { ops: [op('ext.panel', 'A', 1), op('ext.view', 'B', 2)], tab: 'tab-1' }
    await post('/api/ui', exitFirst ? exit : original)
    await post('/api/ui', { ops: sets({ 'ext.panel': 'theirs' }), tab: 'tab-2' })
    await post('/api/ui', exitFirst ? original : exit)
    const state = await server.harness.snapshot(UiState, ROOT_CONVERSATION_ID, context)
    expect(state).toMatchObject({ 'ext.panel': 'theirs', 'ext.view': 'B' })
    expect((await changes()).map(({ key }) => key)).toEqual(
      exitFirst ? ['ext.panel', 'ext.view', 'ext.panel'] : ['ext.panel', 'ext.panel', 'ext.view'],
    )
  })

it('keeps a tab’s last writers across a restart, so a late older op cannot roll a key back', async () => {
  const first = await serve()
  await first.post('/api/ui', { ops: [op('ext.panel', 'final', 2)], tab: 'tab-1' })
  await first.stop()
  const { server, post } = await serve(first.home)
  await post('/api/ui', { ops: [op('ext.panel', 'older', 1)], tab: 'tab-1' })
  const state = await server.harness.snapshot(UiState, ROOT_CONVERSATION_ID, context)
  expect(state).toMatchObject({ 'ext.panel': 'final' })
})

it('keeps the replay record of every key in a large exit batch, so the late original is still refused', async () => {
  const { server, post, send } = await serve()
  const others = Array.from({ length: 999 }, (_, index) => op(`ext.k${index}`, 'x', index + 3))
  await post('/api/ui', {
    ops: [op('ext.panel', 'A', 1), op('ext.panel', 'B', 2), ...others],
    tab: 'tab-1',
  })
  await post('/api/ui', { ops: [op('ext.panel', 'A', 1)], tab: 'tab-1' })
  const state = await server.harness.snapshot(UiState, ROOT_CONVERSATION_ID, context)
  expect(state).toMatchObject({ 'ext.panel': 'B' })
  const tooMany = Array.from({ length: 1001 }, (_, index) => op(`ext.m${index}`, 'x', index + 1))
  expect((await send('/api/ui', { ops: tooMany, tab: 'tab-2' })).status).toBe(413)
})
