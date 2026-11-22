import type { ConversationId } from '@earendil-works/pi-durable'
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import type { SystemInfo } from '../../../../shared/protocol.ts'
import { DocumentsPanel } from '../../panel.solid.tsx'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  return {
    store: createStore({
      eventSource: (url) => {
        const source = new FakeSource(url)
        harness.sources.push(source)
        return source
      },
      fetch: async (url, init) => harness.server!.handle(url as string, init) ?? Response.json({}),
    }),
    registry: createRegistry(),
    uiState: createUiState(undefined),
    api: {},
  }
})

import { registry, store } from '../../../../web/src/sdk/client.ts'
import { ConversationScope, ExtensionName } from '../../../../web/src/sdk/solid.ts'
import type { DocumentProps } from '../../../../web/src/sdk/types.ts'

const agent = createAgent()
harness.server = fakeSubscriptions(harness.sources)

it('opens document views and keeps them up to date as the documents change', async ({
  onTestFinished,
}) => {
  const text = (value: DocumentProps['value']) => (typeof value.text === 'string' ? value.text : '')
  await registry.setLoaders({
    'extensions/example/web.solid.tsx': async () => ({
      default: {
        documents: [
          {
            kind: 'example.first',
            title: 'First view',
            component: (props: DocumentProps) => <b data-first>{text(props.value)}</b>,
          },
          {
            kind: 'example.second',
            title: 'Second view',
            component: (props: DocumentProps) => <b data-second>{text(props.value)}</b>,
          },
        ],
      },
    }),
  })
  store.start()
  onTestFinished(() => store.stop())
  const global = harness.sources[0]
  global.open()
  global.send('system', {
    extensions: [
      { name: 'example', enabled: true, server: { docs: ['example.first', 'example.second'] } },
    ],
  } as SystemInfo)
  const page = renderSolid(() => (
    <ConversationScope value={1 as ConversationId}>
      <ExtensionName value="documents">
        <DocumentsPanel />
      </ExtensionName>
    </ConversationScope>
  ))
  await settle()
  const doc = harness.server!.of(1)!
  doc.send('doc', { kind: 'example.first', value: { text: 'first' } })
  doc.send('doc', { kind: 'example.second', value: { text: 'second' } })
  flush()
  expect(page.querySelector('[data-first]')?.textContent).toBe('first')
  expect(page.querySelector('[data-second]')?.textContent).toBe('second')
  const control = agent
    .snapshot()
    .find((entry) => !entry.offPage && entry.label === 'Document example.second')!
  expect(
    (await agent.act({ steps: [{ ref: control.ref, action: 'setOpen', args: [false] }] })).ok,
  ).toBe(true)
  flush()
  expect(page.querySelector('[data-second]')).toBeNull()
  expect(
    (await agent.act({ steps: [{ ref: control.ref, action: 'setOpen', args: [true] }] })).ok,
  ).toBe(true)
  doc.send('docOps', { kind: 'example.first', ops: [['s', ['text'], 'changed first']] })
  doc.send('docOps', { kind: 'example.second', ops: [['s', ['text'], 'changed second']] })
  flush()
  expect(page.querySelector('[data-first]')?.textContent).toBe('changed first')
  expect(page.querySelector('[data-second]')?.textContent).toBe('changed second')
})
