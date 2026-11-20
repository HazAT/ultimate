/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/solid/agent'
import { settle } from '@ui-sdk/core/testing'
import { createSignal, flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { ExtensionName } from '@/sdk/solid'
import { SOURCE_HEADER } from '../../../../shared/protocol.ts'
import type { UiUpdateRequest } from '../../../../shared/protocol.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import type { Todo } from '../../refs.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  actions: [] as { name: string; args: unknown; source: string | null }[],
  writes: [] as { key: string; value: unknown; source: string | null }[],
  submits: [] as { text: string; source: string | null }[],
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
    if (path === '/api/conversations/69/submit') {
      const { text } = JSON.parse(init!.body as string) as { text: string }
      harness.submits.push({ text, source })
      return Response.json({ ok: true })
    }
    if (path === '/api/extensions/subagents/actions/standing') {
      harness.actions.push({
        name: 'standing',
        args: JSON.parse(init!.body as string).args,
        source,
      })
      return Response.json({ result: 69 })
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

it('lets an agent tick the right one of two same-text to-dos, add one for @ultimate and start one, each sent as the agent’s', async ({
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
    value: {
      next: 4,
      items: [
        todo(1, 'user', 'Renew the cert'),
        todo(2, 'ultimate', 'Tidy'),
        todo(3, 'user', 'Renew the cert'),
      ],
    },
  })
  await settle()
  flush()
  expect(container.querySelector('[data-todos-section="user"]')?.textContent).toContain(
    'Renew the cert',
  )
  expect(container.textContent).toContain('3 open')

  setInbox(2)
  flush()
  expect(container.querySelector('[data-todo-inbox]')?.textContent).toContain('Inbox · 2')
  expect(container.textContent).toContain('2 in Inbox')

  await expectDistinctAgentNames(agent)
  const ticked = await agent.act({
    steps: [
      {
        ref: control('Done #3: Renew the cert', 'checkbox').ref,
        action: 'setChecked',
        args: [true],
      },
    ],
  })
  expect(ticked).toMatchObject({ ok: true })
  expect(harness.actions).toContainEqual({ name: 'done', args: { id: 3 }, source: 'agent' })

  const owner = control('To-do owner', 'segmented-control')
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

  const added = await agent.act({
    steps: [
      { ref: control('To-do text', 'input').ref, action: 'setValue', args: ['Ship it'] },
      { ref: control('Add the to-do', 'button').ref, action: 'press' },
    ],
  })
  expect(added).toMatchObject({ ok: true })
  await settle()
  flush()
  expect(harness.actions).toContainEqual({
    name: 'add',
    args: { text: 'Ship it', owner: 'ultimate' },
    source: 'agent',
  })
  expect(container.querySelector<HTMLInputElement>('input[aria-label="To-do text"]')!.value).toBe(
    '',
  )

  const started = await agent.act({
    steps: [
      {
        ref: control('Have @ultimate work on this #2: Tidy', 'button').ref,
        action: 'press',
      },
    ],
  })
  expect(started).toMatchObject({ ok: true })
  await settle()
  expect(harness.actions).toContainEqual({
    name: 'standing',
    args: { name: 'ultimate' },
    source: 'agent',
  })
  expect(harness.submits).toEqual([{ text: 'Work on to-do #2: Tidy', source: 'agent' }])
})
