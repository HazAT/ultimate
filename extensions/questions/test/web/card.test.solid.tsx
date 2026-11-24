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

import { registry, store, uiState } from '../../../../web/src/sdk/client.ts'
import { FileUpload, provide } from '../../../../web/src/sdk/solid.ts'
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
      options: [
        { label: 'Sidebar', key: 'a' },
        { label: 'Status line', key: 'b' },
      ],
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
  expect(card.querySelector<HTMLTextAreaElement>('[data-note-box] textarea')?.value).toBe(
    'Peak colour on the phone too',
  )
  expect(card.querySelector('fieldset[data-current] button[data-selected]')?.textContent).toContain(
    'Yes',
  )
})

it('announces the current choice and rating, and clears picks without advancing', async () => {
  const withRating: Message = {
    ...message,
    id: 7,
    questions: [...message.questions!, { text: 'How sure are you?', kind: 'scale' }],
  }
  const card = renderSolid(() => (
    <MessageQuestions message={withRating} keys={true} withActions={false} />
  ))
  const field = (index: number) => card.querySelector(`[data-question="${index}"] fieldset`)
  const choice = (label: string) => card.querySelector(`[aria-label="${label}"]`)
  const sidebar = 'Option 1 · Sidebar · question 1 · message 7'
  const status = 'Option 2 · Status line · question 1 · message 7'
  await press(sidebar)
  expect(choice(sidebar)?.getAttribute('aria-current')).toBe('true')
  expect(choice(status)?.getAttribute('aria-current')).toBeNull()
  const key = (value: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key: value }))
  key('Escape')
  await vi.advanceTimersByTimeAsync(350)
  flush()
  expect(choice(sidebar)?.getAttribute('aria-current')).toBeNull()
  expect(field(0)?.hasAttribute('data-current')).toBe(true)
  key('b')
  flush()
  expect(choice(status)?.hasAttribute('data-selected')).toBe(true)
  key('a')
  flush()
  expect(choice(sidebar)?.hasAttribute('data-selected')).toBe(true)
  expect(choice(status)?.hasAttribute('data-selected')).toBe(false)
  key('ArrowDown')
  flush()
  key('ArrowDown')
  flush()
  const rating = 'Rating 3 · question 3 · message 7'
  await press(rating)
  expect(choice(rating)?.getAttribute('aria-current')).toBe('true')
  expect(choice('Rating 2 · question 3 · message 7')?.getAttribute('aria-current')).toBeNull()
  await uiState.flush()
})

it('opens the next question on Enter when recommended picks answer every question', async () => {
  const recommended: Message = {
    ...message,
    id: 9,
    questions: [
      {
        text: 'Where should it sit?',
        kind: 'choice',
        options: [{ label: 'Sidebar', recommended: true }, { label: 'Status line' }],
      },
      {
        text: 'Which label?',
        kind: 'choice',
        options: [{ label: 'Resume' }, { label: 'Résumé', recommended: true }],
      },
    ],
  }
  const card = renderSolid(() => (
    <MessageQuestions message={recommended} keys={true} withActions={false} />
  ))
  const current = () => card.querySelector('[data-question] fieldset[data-current]')
  expect(current()?.closest('[data-question]')?.getAttribute('data-question')).toBe('0')
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  flush()
  expect(current()?.closest('[data-question]')?.getAttribute('data-question')).toBe('1')
  expect(card.querySelector('[aria-label="Undo: answer to message 9"]')).toBeNull()
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  await vi.advanceTimersByTimeAsync(3000)
  expect(harness.actions).toEqual([
    {
      name: 'answer',
      args: {
        messageId: 9,
        answers: [
          { question: 'Where should it sit?', answer: 'Sidebar' },
          { question: 'Which label?', answer: 'Résumé' },
        ],
      },
      source: 'person',
    },
  ])
})

it('keeps typed drafts without recording them, and records a person picking and sending', async () => {
  const typed: Message = { ...message, id: 8 }
  const card = renderSolid(() => (
    <MessageQuestions message={typed} keys={false} withActions={false} />
  ))
  const note = card.querySelector<HTMLTextAreaElement>('[data-note-box] textarea')!
  for (const text of ['O', 'Ok', 'Ok!']) {
    note.value = text
    note.dispatchEvent(new InputEvent('input', { bubbles: true }))
    flush()
    await uiState.flush()
  }
  expect(uiState.get(CARDS_KEY)).toMatchObject({ 'message:8': { note: 'Ok!' } })
  expect(new Set(harness.writers)).toEqual(new Set(['app']))
  harness.writers.length = 0
  card
    .querySelector<HTMLButtonElement>('[aria-label="Option 1 · Sidebar · question 1 · message 8"]')!
    .click()
  flush()
  await uiState.flush()
  expect(harness.writers).toEqual(['person'])
  card.querySelector<HTMLButtonElement>('[aria-label="Send 1 of 2: answer to message 8"]')!.click()
  await vi.advanceTimersByTimeAsync(3000)
  expect(harness.actions).toEqual([
    {
      name: 'answer',
      args: {
        messageId: 8,
        answers: [{ question: 'Where should it sit?', answer: 'Sidebar' }],
        note: 'Ok!',
      },
      source: 'person',
    },
  ])
})

it('lets an agent choose, undo a send, send again, and dismiss another card', async () => {
  const folded: Message = {
    ...message,
    id: 6,
    questions: [
      {
        text: 'Which label should it use?',
        kind: 'choice',
        options: [{ label: 'Resume' }, { label: 'Résumé' }],
      },
    ],
  }
  const card = renderSolid(() => (
    <>
      <MessageQuestions message={message} keys={false} withActions={false} />
      <MessageQuestions message={folded} keys={false} withActions={false} />
    </>
  ))
  await vi.advanceTimersByTimeAsync(10)
  await expectDistinctAgentNames(agent)
  const labels = agent
    .snapshot()
    .filter((entry) => !entry.offPage)
    .map((entry) => entry.label)
  expect(labels).toEqual(
    expect.arrayContaining([
      'Option 1 · Resume · question 1 · message 6',
      'Option 2 · Résumé · question 1 · message 6',
    ]),
  )
  const option = 'Option 2 · Status line · question 1 · message 5'
  await press(option)
  expect(card.querySelector(`[aria-label="${option}"]`)?.hasAttribute('data-selected')).toBe(true)
  await uiState.flush()
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

it('holds Send while a note’s file uploads, then sends it to the asker as an attachment line', async () => {
  let finish!: () => void
  const uploaded = new Promise<void>((resolve) => {
    finish = resolve
  })
  await registry.setLoaders({
    '/extensions/uploads/web.solid.tsx': async () => ({
      default: {
        provides: [
          provide(FileUpload, () => () => ({
            upload: async (file: File) => {
              await uploaded
              return { path: `/tmp/attachments/${file.name}` }
            },
            maxBytes: 1024,
            keptMs: 1000,
          })),
        ],
      },
    }),
  })
  const card = renderSolid(() => (
    <MessageQuestions message={{ ...message, id: 11 }} keys={false} withActions={false} />
  ))
  await vi.advanceTimersByTimeAsync(10)
  flush()
  const note = card.querySelector<HTMLTextAreaElement>('[data-note-box] textarea')!
  note.value = 'See the log'
  note.dispatchEvent(new InputEvent('input', { bubbles: true }))
  const picker = card.querySelector<HTMLInputElement>(
    '[aria-label="Attach files to the note to message 11"] input',
  )!
  Object.defineProperty(picker, 'files', {
    value: [new File(['boom'], 'build.log', { type: 'text/plain' })],
  })
  picker.dispatchEvent(new Event('change', { bubbles: true }))
  await vi.advanceTimersByTimeAsync(10)
  flush()
  expect(card.textContent).toContain('build.log')
  const send = () =>
    card.querySelector<HTMLButtonElement>('[aria-label="Send note: answer to message 11"]')!
  expect(send().disabled).toBe(true)
  note.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  )
  await vi.advanceTimersByTimeAsync(3000)
  expect(harness.actions).toEqual([])
  finish()
  await vi.advanceTimersByTimeAsync(10)
  flush()
  await press('Send note: answer to message 11')
  await vi.advanceTimersByTimeAsync(3000)
  expect(harness.actions).toEqual([
    {
      name: 'answer',
      args: {
        messageId: 11,
        answers: [],
        note: 'See the log\n\nAttached file: `build.log` (4 B, text/plain) at `/tmp/attachments/build.log`',
      },
      source: 'agent',
    },
  ])
  await registry.setLoaders({})
})
