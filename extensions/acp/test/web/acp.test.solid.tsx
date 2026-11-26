import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import type { StreamedView } from '../../../../shared/protocol.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, answerReadsWith, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  writes: [] as { path: string; source: string | null }[],
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const fetch = answerReadsWith(async (url, init) => {
    const path = url as string
    const subscription = server.handle(path, init)
    if (subscription) return subscription
    if (path.endsWith('/available')) return Response.json({ result: true })
    if (path.startsWith('/api/extensions/acp/')) {
      harness.writes.push({ path, source: new Headers(init?.headers).get('x-ultimate-source') })
      return Response.json({ error: 'Antigravity takes only your own input' }, { status: 500 })
    }
    return Response.json({ result: null })
  })
  const store = createStore({
    eventSource: (url) => {
      const source = new FakeSource(url)
      harness.sources.push(source)
      return source
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

import { ModelPicker } from '../../../models/picker.solid.tsx'
import { registry, store } from '../../../../web/src/sdk/client.ts'
import type { AcpSession } from '../../refs.ts'
import web, { AcpComposer, LiveTail } from '../../web.solid.tsx'

const server = fakeSubscriptions(harness.sources)
const agent = createAgent()
const model = {
  id: 'model',
  name: 'Model',
  value: 'pro',
  options: [
    { value: 'pro', name: 'Gemini Pro' },
    { value: 'flash', name: 'Gemini Flash' },
  ],
}

it('names the picker, composer, config and permission controls distinctly and gates agent decisions', async ({
  onTestFinished,
}) => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  await registry.setLoaders({ 'extensions/acp/web.solid.tsx': async () => ({ default: web }) })
  store.start()
  onTestFinished(() => {
    store.stop()
    vi.unstubAllGlobals()
  })
  harness.sources[0].open()
  await settle()
  const doc = (session: Partial<AcpSession>) => {
    server.of()!.send('doc', { kind: 'acp.session', value: session })
    flush()
  }
  server.of()!.send('view', {
    conversation: { id: 1, label: 'acp' },
    entries: [],
    docs: {},
  } as unknown as StreamedView)
  const page = renderSolid(() => (
    <>
      <LiveTail />
      <AcpComposer core={<p>Pi composer</p>} />
      <ModelPicker />
    </>
  ))
  await settle()
  doc({ status: 'idle', config: [model] })
  await settle()
  const button = (label: string) =>
    page.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
  expect(page.textContent).not.toContain('Pi composer')
  await expectDistinctAgentNames(agent)
  const text = page.querySelector('textarea')!
  text.setRangeText('Not a personal prompt')
  text.dispatchEvent(new InputEvent('input', { bubbles: true }))
  flush()
  const send = agent.snapshot().find((item) => item.label === 'Send prompt to Antigravity #1')!
  await agent.act({ steps: [{ ref: send.ref, action: 'press' }] })
  expect(harness.writes).toEqual([{ path: '/api/extensions/acp/actions/prompt', source: 'agent' }])

  const menu = agent.snapshot().find((item) => item.label === 'Antigravity Model (model) in #1')!
  const setOpen = (open: boolean) =>
    agent.act({ steps: [{ ref: menu.ref, action: 'setOpen', args: [open] }] })
  expect((await setOpen(true)).ok).toBe(true)
  expect(page.querySelector('[role="menuitemradio"][aria-label*="Gemini Flash"]')).not.toBeNull()
  await expectDistinctAgentNames(agent)
  expect((await setOpen(false)).ok).toBe(true)

  doc({
    status: 'running',
    config: [model],
    permission: {
      title: 'Read notes.txt',
      options: [
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
      ],
    },
  })
  expect(page.textContent).toContain('Read notes.txt')
  await expectDistinctAgentNames(agent)
  const permit = agent
    .snapshot()
    .find((item) => item.label === 'Allow once (allow) for Antigravity #1')!
  expect((await agent.act({ steps: [{ ref: permit.ref, action: 'press' }] })).ok).toBe(false)
  expect(harness.writes).toHaveLength(1)

  button('Open model picker from Antigravity #1').click()
  await settle()
  expect(page.textContent).toContain('agy acp')
  expect(page.textContent).toContain('worktree')
  await expectDistinctAgentNames(agent)
})
