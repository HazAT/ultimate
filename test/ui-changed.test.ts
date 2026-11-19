import { resolve } from 'node:path'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { context } from '../server/harness.ts'
import { EventFeed } from '../server/events.ts'
import { ChangedEvent } from '../shared/events.ts'
import { UiState } from '../shared/ui-state.ts'
import { DRIVEN_HEADER, SOURCE_HEADER } from '../shared/protocol.ts'
import { fauxServer, removeTemp, temp } from './helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

async function serve() {
  const home = await temp()
  cleanup.push(() => removeTemp(home))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: home,
    userHome: home,
    home: `${home}/state`,
    port: 0,
  })
  cleanup.push(() => server.close())
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
  return { server, send, post, changes }
}

it('records each stored UI-state change in the commit that writes it, with who, from where and the device', async () => {
  const { server, send, post, changes } = await serve()
  const agent = { [SOURCE_HEADER]: 'agent', [DRIVEN_HEADER]: '1' }
  await post('/api/ui', { set: { 'ext.digest.on': true, 'shell.panel': 'tasks' } }, agent)
  await post('/api/ui', { set: { 'ext.digest.on': true } })
  await post('/api/ui', { set: { 'ext.notes.text': 'x'.repeat(3000) }, delete: ['ext.digest.on'] })
  await post('/api/ui', { delete: ['ext.never.set'] })
  await post('/api/ui', { set: { 'ext.sidebar.seen': { 7: 1 } } }, { [SOURCE_HEADER]: 'app' })
  const refused = await send('/api/ui', { set: { 'ext.huge': 'x'.repeat(300 * 1024) } })
  expect(refused.status).toBe(413)

  const device = 'desktop firefox'
  expect(await changes()).toEqual([
    { key: 'ext.digest.on', value: true, source: 'agent', driven: true, device },
    { key: 'ext.notes.text', value: '[too large]', source: 'person', device },
    { key: 'ext.digest.on', previous: true, source: 'person', device },
  ])
  const state = await server.harness.snapshot(UiState, ROOT_CONVERSATION_ID, context)
  expect(state).toMatchObject({ 'shell.panel': 'tasks', 'ext.sidebar.seen': { 7: 1 }, 'ui.rev': 5 })
  expect(state).not.toHaveProperty('ext.huge')
})

it('records keep-warm’s switch as a UI change in its own commit, by the agent only when the page says so', async () => {
  const { post, changes } = await serve()
  const set = (on: boolean, headers?: Record<string, string>) =>
    post('/api/extensions/keep-warm/actions/set', { args: { on } }, headers)
  await set(false, { [SOURCE_HEADER]: 'agent' })
  await set(false)
  await set(true)
  expect(await changes()).toEqual([
    expect.objectContaining({ key: 'keep-warm.on', value: false, previous: true, source: 'agent' }),
    expect.objectContaining({
      key: 'keep-warm.on',
      value: true,
      previous: false,
      source: 'person',
    }),
  ])
})
