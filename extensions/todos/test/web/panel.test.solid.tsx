/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/solid/agent'
import { settle } from '@ui-sdk/core/testing'
import { createSignal, flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { ExtensionName } from '@/sdk/solid'
import { SOURCE_HEADER } from '../../../../shared/protocol.ts'
import type { UiUpdateRequest } from '../../../../shared/protocol.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import type { Todo } from '../../refs.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  actions: [] as { name: string; args: unknown; source: string | null }[],
  writes: [] as { key: string; value: unknown; source: string | null }[],
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    const source = new Headers(init?.headers).get(SOURCE_HEADER)
    if (path === '/api/ui') {
      const { ops } = JSON.parse(init!.body as string) as UiUpdateRequest
      for (const { key, value } of ops) harness.writes.push({ key, value, source })
      return Response.json({ ok: true, rev: 1 })
    }
    const action = /^\/api\/extensions\/todos\/actions\/(\w+)$/.exec(path)
    if (!action) return harness.server?.handle(path, init) ?? Response.json({ ok: true })
    const { args } = JSON.parse(init!.body as string) as { args: unknown }
    harness.actions.push({ name: action[1], args, source })
    return Response.json({ result: {} })
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
    uiState: createUiState(api.updateUi),
  }
})

import { store, uiState } from '../../../../web/src/sdk/client.ts'
import { TodoList } from '../../panel.solid.tsx'

const agent = createAgent()
harness.server = fakeSubscriptions(harness.sources)
const todo = (id: number, owner: Todo['owner'], text: string): Todo => ({
  id,
  owner,
  text,
  at: Date.now() - 60_000,
})
const control = (label: string, component: string) => {
  const found = agent
    .snapshot()
    .find((entry) => !entry.offPage && entry.label === label && entry.component === component)
  if (!found) throw new Error(`Missing ${component}: ${label}`)
  return found
}

it('lets an agent tick a to-do and add one for @ultimate, each sent as the agent’s', async ({
  onTestFinished,
}) => {
  store.start()
  onTestFinished(() => store.stop())
  harness.sources[0].open()
  const [inbox, setInbox] = createSignal(0)
  const container = renderSolid(() => (
    <ExtensionName value="todos">
      <TodoList inbox={inbox()} />
    </ExtensionName>
  ))
  await settle()
  harness.server!.of(1)!.send('doc', {
    kind: 'todos',
    value: { next: 3, items: [todo(1, 'user', 'Renew the cert'), todo(2, 'ultimate', 'Tidy')] },
  })
  await settle()
  flush()
  expect(container.querySelector('[data-todos-section="user"]')?.textContent).toContain(
    'Renew the cert',
  )
  expect(container.textContent).toContain('2 open')

  setInbox(2)
  flush()
  expect(container.querySelector('[data-todo-inbox]')?.textContent).toContain('Inbox · 2')
  expect(container.textContent).toContain('2 in Inbox')

  const ticked = await agent.act({
    steps: [
      { ref: control('Done: Renew the cert', 'checkbox').ref, action: 'setChecked', args: [true] },
    ],
  })
  expect(ticked).toMatchObject({ ok: true })
  expect(harness.actions).toContainEqual({ name: 'done', args: { id: 1 }, source: 'agent' })

  const owner = control('New to-do for', 'segmented-control')
  expect(owner).toMatchObject({ value: 'user' })
  const picked = await agent.act({
    steps: [{ ref: owner.ref, action: 'setValue', args: ['ultimate'] }],
  })
  expect(picked).toMatchObject({ ok: true })
  await uiState.flush()
  expect(harness.writes).toContainEqual({
    key: 'ext.todos.owner',
    value: 'ultimate',
    source: 'agent',
  })

  const input = container.querySelector<HTMLInputElement>('input[aria-label="New to-do"]')!
  input.value = 'Ship it'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  flush()
  input.form!.requestSubmit()
  await settle()
  flush()
  expect(harness.actions).toContainEqual({
    name: 'add',
    args: { text: 'Ship it', owner: 'ultimate' },
    source: 'person',
  })
  expect(input.value).toBe('')
})
