/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import type { Message } from '../../open.ts'
import { CARDS_KEY } from '../../state.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  actions: [] as { name: string; args: unknown; source: string | null }[],
  writers: [] as string[],
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const [{ createStore }, { createApi }, { createUiState }, { createRegistry }] = await Promise.all(
    [
      import('../../../../web/src/sdk/store.ts'),
      import('../../../../web/src/sdk/api.ts'),
      import('../../../../web/src/sdk/ui-state.ts'),
      import('../../../../web/src/sdk/registry.ts'),
    ],
  )
  const subscriptions = fakeSubscriptions(harness.sources)
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    const name = /^\/api\/extensions\/questions\/actions\/(\w+)$/.exec(path)?.[1]
    if (!name) return subscriptions.handle(path, init) ?? Response.json({ ok: true })
    const { args } = JSON.parse(init!.body as string) as { args: unknown }
    harness.actions.push({
      name,
      args,
      source: new Headers(init!.headers).get('x-ultimate-source'),
    })
    return Response.json({ result: { id: 100 } })
  }
  const store = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch,
  })
  return {
    store,
    api: createApi(store, { fetch }),
    uiState: createUiState(
      async (_change, who) => {
        harness.writers.push(who)
        return { ok: true, rev: harness.writers.length }
      },
      { delayMs: 0 },
    ),
    registry: createRegistry(),
  }
})

import { store, uiState } from '../../../../web/src/sdk/client.ts'
import { MessageQuestions } from '../../card.solid.tsx'

const agent = createAgent()
const message: Message = {
  id: 5,
  from: 2,
  to: 'user',
  reply: true,
  state: 'delivered',
  questions: [
    {
      text: 'Where should it sit?',
      kind: 'choice',
      options: [{ label: 'Sidebar' }, { label: 'Status line' }],
    },
    { text: 'Land it?', kind: 'confirm' },
  ],
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }))
  harness.sources.length = 0
  harness.actions.length = 0
  harness.writers.length = 0
  uiState.receive({})
  store.start()
  harness.sources[0].open()
  await vi.advanceTimersByTimeAsync(10)
})
afterEach(() => {
  store.stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function press(label: string) {
  const control = agent.snapshot().find((entry) => !entry.offPage && entry.label === label)
  expect(control).toBeDefined()
  const result = agent.act({ steps: [{ ref: control!.ref, action: 'press' }] })
  await vi.advanceTimersByTimeAsync(100)
  flush()
  expect(await result).toMatchObject({ ok: true })
}

it('shows the saved picks, note and open question on a fresh mount', () => {
  uiState.receive({
    [CARDS_KEY]: {
      'message:5': {
        drafts: { 0: { chosen: [1] }, 1: { chosen: [0] } },
        note: 'Peak colour on the phone too',
        current: 1,
        text: '',
      },
    },
  })
  const card = renderSolid(() => (
    <MessageQuestions message={message} keys={false} withActions={false} />
  ))
  expect(card.textContent).toContain('2/2')
  expect(card.querySelector<HTMLTextAreaElement>('textarea[data-note]')?.value).toBe(
    'Peak colour on the phone too',
  )
  expect(
    card.querySelector('fieldset[data-current] button[aria-pressed=true]')?.textContent,
  ).toContain('Yes')
})

it('lets agents distinguish options whose labels fold to the same name', async () => {
  renderSolid(() => (
    <MessageQuestions
      message={{
        ...message,
        questions: [
          {
            text: 'Which label should it use?',
            kind: 'choice',
            options: [{ label: 'Resume' }, { label: 'Résumé' }],
          },
        ],
      }}
      keys={false}
      withActions={false}
    />
  ))
  await vi.advanceTimersByTimeAsync(10)
  await expectDistinctAgentNames(agent)
  expect(
    agent
      .snapshot()
      .filter((entry) => !entry.offPage)
      .map((entry) => entry.label),
  ).toEqual(
    expect.arrayContaining([
      'Option 1 · Resume · question 1 · message 5',
      'Option 2 · Résumé · question 1 · message 5',
    ]),
  )
})

it('lets an agent choose, undo a send, send again, and dismiss another card', async () => {
  const card = renderSolid(() => (
    <>
      <MessageQuestions message={message} keys={false} withActions={false} />
      <MessageQuestions message={{ ...message, id: 6 }} keys={false} withActions={false} />
    </>
  ))
  await vi.advanceTimersByTimeAsync(10)
  await expectDistinctAgentNames(agent)
  const option = 'Option 2 · Status line · question 1 · message 5'
  await press(option)
  expect(card.querySelector(`[aria-label="${option}"]`)?.getAttribute('aria-pressed')).toBe('true')
  expect(harness.writers).toEqual(['agent'])
  await vi.advanceTimersByTimeAsync(320)
  expect(
    card
      .querySelector('[data-questions-card="message:5"] [data-question="1"] fieldset')
      ?.hasAttribute('data-current'),
  ).toBe(true)
  await press('Send 1 of 2: answer to message 5')
  await expectDistinctAgentNames(agent)
  expect(harness.actions).toEqual([])
  await press('Undo: answer to message 5')
  await vi.advanceTimersByTimeAsync(3000)
  expect(harness.actions).toEqual([])
  await press('Send 1 of 2: answer to message 5')
  await vi.advanceTimersByTimeAsync(3000)
  await press('Dismiss message 6')
  expect(harness.actions).toEqual([
    {
      name: 'answer',
      args: {
        messageId: 5,
        answers: [{ question: 'Where should it sit?', answer: 'Status line' }],
      },
      source: 'agent',
    },
    { name: 'dismiss', args: { messageId: 6 }, source: 'agent' },
  ])
})
