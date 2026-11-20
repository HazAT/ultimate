/** @jsxImportSource @solidjs/web */
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush, useContext } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.ts'
import type { StreamedView } from '../../../../shared/protocol.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  opened: [] as { args: unknown; source: string | null }[],
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const subscriptions = (harness.server = fakeSubscriptions(harness.sources))
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    if (path === '/api/extensions/side-chat/actions/open') {
      harness.opened.push({
        args: JSON.parse(init!.body as string).args,
        source: new Headers(init?.headers).get('x-ultimate-source'),
      })
      return Response.json({ result: { id: 82 } })
    }
    return subscriptions.handle(path, init) ?? Response.json({ ok: true, rev: 1 })
  }
  const store = createStore({
    eventSource: (url) => {
      const source = new FakeSource(url)
      harness.sources.push(source)
      return source
    },
    fetch,
  })
  return { store, api: createApi(store, { fetch }), uiState: createUiState(undefined) }
})

import { store, uiState } from '../../../../web/src/sdk/client.ts'
import { ComposerRedirect } from '../../../../web/src/sdk/solid.ts'
import { ComposerFrame } from '../../frame.solid.tsx'

const agent = createAgent()
const main = 44

beforeEach(async ({ onTestFinished }) => {
  harness.sources.length = 0
  harness.opened.length = 0
  uiState.receive({})
  store.start()
  onTestFinished(() => store.stop())
  harness.sources[0].open()
  store.show(parseConversationId(main))
  await settle()
  harness.server!.of(main)!.send('view', {
    conversation: { id: main },
    entries: [],
    docs: {},
  } as unknown as StreamedView)
  await settle()
  flush()
})
afterEach(() => vi.unstubAllGlobals())

function Core() {
  const target = useContext(ComposerRedirect)
  return (
    <div>
      <textarea id="composer-input" placeholder={target()?.placeholder ?? 'To main'} />
      <button onClick={() => void target()?.send('a side question')} type="button">
        send
      </button>
    </div>
  )
}

async function mount() {
  const container = renderSolid(() => <ComposerFrame core={<Core />} />)
  await settle()
  harness.server!.of(1)!.send('doc', {
    kind: 'ultimate.standing-agents',
    value: { ultimate: main },
  })
  flush()
  return container
}

it('keeps an outer composer redirect while side chat mode is off', async () => {
  const outer = { placeholder: 'Sent elsewhere', send: async () => undefined }
  const container = renderSolid(() => (
    <ComposerRedirect value={() => outer}>
      <ComposerFrame core={<Core />} />
    </ComposerRedirect>
  ))
  await settle()
  harness.server!.of(1)!.send('doc', {
    kind: 'ultimate.standing-agents',
    value: { ultimate: main },
  })
  flush()
  expect(container.querySelector('[data-side-mode]')?.getAttribute('data-side-mode')).toBe('normal')
  expect(container.querySelector<HTMLTextAreaElement>('#composer-input')!.placeholder).toBe(
    'Sent elsewhere',
  )
})

it('makes main’s composer inert while a side chat is in front, with Back to main outside it', async () => {
  const container = await mount()
  harness.server!.of(main)!.send('doc', {
    kind: 'sidechat.index',
    value: { sides: [{ id: 82, at: 40, openedAt: 0 }] },
  })
  await settle()
  flush()
  const covered = () => container.querySelector('[data-main-composer]')!
  expect(covered().hasAttribute('inert')).toBe(false)
  expect(container.textContent).not.toContain('Back to main')

  uiState.set('ext.side-chat.front', 82)
  flush()
  expect(covered().hasAttribute('inert')).toBe(true)
  expect(covered().contains(container.querySelector('#composer-input'))).toBe(true)
  const back = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Back to main'),
  )!
  expect(covered().contains(back)).toBe(false)
  back.click()
  flush()
  expect(covered().hasAttribute('inert')).toBe(false)
})

it('switches to side chat mode on Tab or the switch, opens a side chat on send, then returns to normal', async () => {
  const container = await mount()
  const editor = container.querySelector<HTMLTextAreaElement>('#composer-input')!
  const frame = () => container.querySelector('[data-side-mode]')!.getAttribute('data-side-mode')
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  flush()
  expect(frame()).toBe('side')
  expect(editor.placeholder).toBe('Ask on the side — @ultimate keeps running…')
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  flush()
  expect(frame()).toBe('normal')

  await expectDistinctAgentNames(agent)
  const switched = await agent.act({
    steps: [{ ref: 'Composer sends to @ultimate · Tab switches', action: 'press' }],
  })
  expect(switched).toMatchObject({ ok: true })
  flush()
  expect(frame()).toBe('side')
  const send = [...container.querySelectorAll('button')].find((b) => b.textContent === 'send')!
  send.click()
  await settle()
  flush()
  expect(harness.opened).toEqual([{ args: { text: 'a side question' }, source: 'person' }])
  expect(frame()).toBe('normal')
  expect(uiState.snapshot()['ext.side-chat.front']).toBe(82)
})
