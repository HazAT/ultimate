/** @jsxImportSource @solidjs/web */
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import type { SetupIssue } from '../../refs.ts'

const harness = vi.hoisted(() => ({ sources: [] as FakeSource[] }))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const subscriptions = fakeSubscriptions(harness.sources)
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input !== '/api/extensions/setup/actions/check')
      return subscriptions.handle(input as string, init) ?? Response.json({ ok: true })
    return Response.json({
      result: [
        {
          area: 'Secrets',
          status: 'warn',
          summary: 'EXAMPLE_KEY missing',
          fix: { label: 'Add', secret: 'EXAMPLE_KEY' },
        },
        {
          area: 'Extensions',
          status: 'warn',
          summary: 'example is off',
          fix: { label: 'Review', command: 'example.review' },
        },
      ] satisfies SetupIssue[],
    })
  }
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

import { registry, store } from '../../../../web/src/sdk/client.ts'
import { events } from '../../../../web/src/sdk/events.ts'
import { writerNow } from '../../../../web/src/sdk/writer.ts'
import { Chip } from '../../chip.solid.tsx'

const agent = createAgent()

it('lets an agent open setup issues and ask the Secrets panel for the missing key', async ({
  onTestFinished,
}) => {
  store.start()
  onTestFinished(() => store.stop())
  harness.sources[0].open()
  renderSolid(() => <Chip />)
  await settle()
  flush()

  const request = vi.fn<(data: unknown, source: string) => void>()
  onTestFinished(events.on('secrets:open', (data) => request(data, writerNow())))
  const chip = agent.snapshot().find((item) => item.label === '2 setup issues')
  expect(chip).toMatchObject({ component: 'popover' })
  expect(
    await agent.act({ steps: [{ ref: chip!.ref, action: 'setOpen', args: [true] }] }),
  ).toMatchObject({ ok: true })
  const control = agent.snapshot().find((item) => item.label === 'Add')
  expect(await agent.act({ steps: [{ ref: control!.ref, action: 'press' }] })).toMatchObject({
    ok: true,
  })
  expect(request).toHaveBeenCalledExactlyOnceWith({ name: 'EXAMPLE_KEY' }, 'agent')
})

it('shows a command fix once its command is installed, and runs it as the agent that pressed it', async ({
  onTestFinished,
}) => {
  store.start()
  onTestFinished(() => store.stop())
  harness.sources[0].open()
  renderSolid(() => <Chip />)
  await settle()
  flush()
  const chip = agent.snapshot().find((item) => item.label === '2 setup issues')
  await agent.act({ steps: [{ ref: chip!.ref, action: 'setOpen', args: [true] }] })
  expect(agent.snapshot().some((item) => item.label === 'Review')).toBe(false)

  const ran = vi.fn<(source: string) => void>()
  await registry.setLoaders({
    'extensions/example/web.tsx': async () => ({
      default: {
        commands: [{ id: 'example.review', title: 'Review', run: () => ran(writerNow()) }],
      },
    }),
  })
  await settle()
  flush()
  const review = agent.snapshot().find((item) => item.label === 'Review')
  expect(await agent.act({ steps: [{ ref: review!.ref, action: 'press' }] })).toMatchObject({
    ok: true,
  })
  await settle()
  expect(ran).toHaveBeenCalledExactlyOnceWith('agent')
})
