import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseConversationId, parseEntryId } from '../../../../lib/ids.shared.ts'
import type { StreamedView } from '../../../../shared/protocol.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import type { JsonObject } from '@earendil-works/pi-durable'
import type { SideChatSession } from '../../refs.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  actions: [] as { name: string; args: unknown; source: string | null }[],
  writes: [] as { key: string; who: string }[],
  refuse: new Set<string>(),
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const [{ createStore }, { createApi }, { createUiState }, { createRegistry }, { createReads }] =
    await Promise.all([
      import('../../../../web/src/sdk/store.ts'),
      import('../../../../web/src/sdk/api.ts'),
      import('../../../../web/src/sdk/ui-state.ts'),
      import('../../../../web/src/sdk/registry.ts'),
      import('../../../../web/src/sdk/reads.ts'),
    ])
  const subscriptions = (harness.server = fakeSubscriptions(harness.sources, async () =>
    Response.json({ result: null }),
  ))
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    const name = /^\/api\/extensions\/side-chat\/actions\/(\w+)$/.exec(path)?.[1]
    if (!name) return subscriptions.handle(path, init) ?? Response.json({ ok: true })
    const { args } = JSON.parse(init!.body as string) as { args: unknown }
    harness.actions.push({
      name,
      args,
      source: new Headers(init!.headers).get('x-ultimate-source'),
    })
    if (harness.refuse.has(name))
      return Response.json({ error: `side-chat/${name}: No side chat is open` }, { status: 400 })
    return Response.json({ result: { conversation: 90 } })
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
    reportCompact: vi.fn<(extension: string, error: unknown) => void>(),
    uiState: createUiState(
      async (change, who) => {
        for (const op of change.ops) harness.writes.push({ key: op.key, who })
        return { ok: true, rev: harness.writes.length }
      },
      { delayMs: 0 },
    ),
  }
})

import { regionOpen } from '../../../../web/src/sdk/actions.ts'
import { store, uiState } from '../../../../web/src/sdk/client.ts'
import { Composer, ExtensionName, openPanel } from '../../../../web/src/sdk/solid.ts'
import { dock, setSideChatOpen, setSideChatSource } from '../../dock.solid.tsx'
import { SideChatPanel, SideChatOverlay } from '../../panel.solid.tsx'
import { SideComposer } from '../../frame.solid.tsx'
import { PinnedQuestion } from '../../pinned.solid.tsx'
import { StoredTurn } from '../../turns.solid.tsx'

const agent = createAgent()
const ultimate = 44
const fork = parseConversationId(90)

vi.stubGlobal('speechSynthesis', { cancel() {}, speak() {}, getVoices: () => [] })
vi.stubGlobal('SpeechSynthesisUtterance', EventTarget)
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
  },
)

beforeEach(async ({ onTestFinished }) => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  harness.sources.length = 0
  harness.actions.length = 0
  harness.writes.length = 0
  harness.refuse.clear()
  setSideChatOpen(false)
  dock.setSideMode(false)
  uiState.receive({})
  store.start()
  onTestFinished(() => store.stop())
  harness.sources[0].open()
  store.show(parseConversationId(ultimate))
  await settle()
  harness.server!.of(ultimate)!.send('view', {
    conversation: { id: ultimate },
    entries: [],
    docs: { 'pi.agent': { model: { provider: 'faux', modelId: 'faux-1' } } },
  } as unknown as StreamedView)
  await settle()
  flush()
})
afterEach(() => {
  setSideChatOpen(false)
})
afterAll(() => vi.unstubAllGlobals())

async function root(session: SideChatSession, extra: Record<string, Readonly<JsonObject>> = {}) {
  await settle()
  const at = harness.server!
  const send = (kind: string, value: Readonly<JsonObject>) => {
    const carries = at.subscriptions.some(
      (each) => !each.closed && each.conversation === 1 && each.docs.includes(kind),
    )
    if (carries) at.of(1)!.send('doc', { kind, value })
  }
  send('ultimate.standing-agents', { ultimate })
  send('side-chat.session', session)
  for (const [kind, value] of Object.entries(extra)) send(kind, value)
  await settle()
  flush()
}

const ended = (reason: 'quiet' | 'fresh' | 'answered', summary?: string) => ({
  sessions: {
    [ultimate]: {
      last: {
        id: fork,
        endedAt: new Date('2026-11-28T09:41:00').getTime(),
        reason,
        handedOff: false,
        ...(summary ? { summary } : {}),
      },
    },
  },
})

it('offers no box until the source is known, so a draft never moves to another source', async () => {
  const view = renderSolid(() => <SideChatPanel />)
  await settle()
  flush()
  expect(view.querySelector('textarea')).toBeNull()
  await root({ sessions: {} })
  expect(view.querySelector('textarea')).not.toBeNull()
})

it('after it ends, shows the previous fork above a closing line naming the reason and what went back', async () => {
  const view = renderSolid(() => <SideChatPanel />)
  const line = () =>
    [...view.querySelectorAll('[data-side-chat-ended] > *')]
      .map((part) => part.textContent)
      .join(' | ')
  await root(ended('quiet'))
  expect(line()).toContain('concluded· 09:41 | ')
  expect(line()).toContain('ended after 20 min quiet · nothing to hand back')
  await root(ended('fresh', 'Decided: keep the segment.'))
  expect(line()).toContain('started fresh · summary sent to @ultimate')
  await root(ended('answered'))
  expect(line()).toContain('answered the card · nothing to hand back')
  expect(view.querySelector('[data-closing-line]')?.getAttribute('data-closing-line')).toBe(
    'answered',
  )
  expect(harness.server!.of(fork)).toBeDefined()
  expect(view.querySelector('textarea')?.placeholder).toBe(
    'Your next message starts a fresh side chat…',
  )
  expect(view.textContent).not.toContain('start fresh')
})

it('Start fresh ends the open side chat as the person, and a refusal leaves it open with the error', async () => {
  const view = renderSolid(() => <SideChatPanel />)
  await root({ sessions: { [ultimate]: { id: fork, startedAt: 1 } } })
  await expectDistinctAgentNames(agent)
  harness.refuse.add('end')
  view
    .querySelector<HTMLButtonElement>(`[aria-label="Start fresh: end side chat #${fork}"]`)!
    .click()
  await vi.waitFor(() =>
    expect(view.querySelector('[role="alert"]')?.textContent).toBe('No side chat is open'),
  )
  expect(harness.actions.filter((call) => call.name !== 'status')).toEqual([
    { name: 'end', args: { source: ultimate }, source: 'person' },
  ])
  expect(view.querySelector(`[aria-label="Start fresh: end side chat #${fork}"]`)).not.toBeNull()
  expect(view.querySelector('[data-side-chat-ended]')).toBeNull()
})

it('Conversation mode is on by default, and switching it is the person’s write', async () => {
  renderSolid(() => <SideChatPanel />)
  await root({ sessions: {} })
  expect(dock.conversation()).toBe(true)
  const result = await agent.act({
    steps: [{ ref: 'Conversation mode', action: 'setChecked', args: [false] }],
  })
  expect(result).toMatchObject({ ok: true })
  await uiState.flush()
  expect(dock.conversation()).toBe(false)
  expect(harness.writes).toContainEqual({ key: 'ext.side-chat.conversation', who: 'agent' })
  harness.writes.length = 0
  dock.setConversation(true)
  await uiState.flush()
  expect(harness.writes).toContainEqual({ key: 'ext.side-chat.conversation', who: 'person' })
})

it('the Normal / Side chat segment and Tab switch @ultimate’s box into side chat mode as the person', async () => {
  const view = renderSolid(() => <SideComposer core={<textarea id="composer-input" />} />)
  await root({ sessions: {} })
  const mode = () => view.querySelector('[data-side-mode]')?.getAttribute('data-side-mode')
  expect(mode()).toBe('normal')
  await expectDistinctAgentNames(agent)
  view
    .querySelector('#composer-input')!
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  flush()
  await uiState.flush()
  expect(mode()).toBe('side')
  expect(harness.writes).toContainEqual({ key: 'ext.side-chat.side-mode', who: 'person' })
  expect(harness.actions).toEqual([])
  const toggle = await agent.act({
    steps: [
      {
        ref: 'Composer sends to a new side chat · Tab switches',
        action: 'setPressed',
        args: [false],
      },
    ],
  })
  expect(toggle).toMatchObject({ ok: true })
  expect(mode()).toBe('normal')
})

it('the pinned card sends its answer through the side chat, and a refusal keeps the card with the error', async () => {
  const message = {
    id: 5,
    from: ultimate,
    to: 'user',
    reply: true,
    state: 'delivered',
    text: 'Which way?',
    questions: [{ text: 'Which way?', kind: 'confirm' }],
  }
  const view = renderSolid(() => <PinnedQuestion fork={fork} message={5} />)
  await root(
    { sessions: { [ultimate]: { id: fork, question: 5 } } },
    {
      board: { messages: [message] },
    },
  )
  await expectDistinctAgentNames(agent)
  view
    .querySelector<HTMLButtonElement>('[aria-label="Option 1 · Yes · question 1 · message 5"]')!
    .click()
  flush()
  harness.refuse.add('answer')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  view.querySelector<HTMLButtonElement>('[aria-label="Send answer: answer to message 5"]')!.click()
  await vi.advanceTimersByTimeAsync(3000)
  vi.useRealTimers()
  await vi.waitFor(() =>
    expect(view.textContent).toContain('Nothing was sent: No side chat is open'),
  )
  expect(harness.actions).toEqual([
    {
      name: 'answer',
      args: {
        source: ultimate,
        fork,
        message: 5,
        answer: { answers: [{ question: 'Which way?', answer: 'Yes' }] },
      },
      source: 'person',
    },
  ])
  expect(view.querySelector('[data-pinned-question="5"]')).not.toBeNull()
})

it('Enter in side chat mode sends the first turn to @ultimate’s side chat, opens the window and returns to Normal', async () => {
  setSideChatSource(undefined)
  uiState.set('ext.side-chat.source', null)
  const view = renderSolid(() => <SideComposer core={<Composer />} />)
  await root({ sessions: {} })
  const editor = view.querySelector<HTMLTextAreaElement>('#composer-input')!
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  flush()
  expect(editor.placeholder).toBe('Ask on the side — @ultimate keeps running…')
  const fill = await agent.act({
    steps: [{ ref: 'Prompt for conversation #44', action: 'setValue', args: ['a side question'] }],
  })
  expect(fill).toMatchObject({ ok: true })
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await settle()
  expect(harness.actions.find((call) => call.name === 'turn')).toMatchObject({
    args: { source: ultimate, text: 'a side question' },
    source: 'person',
  })
  expect(dock.sideMode()).toBe(false)
  expect(dock.open()).toBe(true)
})

it('an archived voice turn with no inline text shows its recorded transcript', async () => {
  const data = {
    key: 'archived-turn',
    text: '',
    route: 'audio' as const,
    audio: 'clip-b',
    clips: ['clip-a', 'clip-b'],
  }
  const view = renderSolid(() => (
    <StoredTurn
      entry={{
        id: parseEntryId(7),
        kind: 'voice.turn',
        conversationId: fork,
        data,
      }}
    />
  ))
  await settle()
  harness.server!.of(fork)!.send('doc', {
    kind: 'voice.fork',
    value: { transcripts: { 'clip-a': 'Leave the record', 'clip-b': 'as it was.' } },
  })
  flush()
  expect(view.textContent).toContain('Leave the record as it was.')
  expect(view.textContent).not.toContain('Transcript unavailable')
})

it('closing a docked side chat restores the previous panel even when Panels was closed', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }))
  renderSolid(() => (
    <ExtensionName value="side-chat">
      <SideChatOverlay />
    </ExtensionName>
  ))
  await root({ sessions: {} })
  uiState.set('shell.panel', 'tasks')
  await uiState.flush()
  expect(regionOpen('panels')).toBe(false)
  harness.writes.length = 0
  setSideChatOpen(true)
  flush()
  await settle()
  await uiState.flush()
  expect(uiState.get('shell.panel')).toBe('side-chat')
  expect(regionOpen('panels')).toBe(true)
  setSideChatOpen(false)
  flush()
  await settle()
  await uiState.flush()
  expect(regionOpen('panels')).toBe(false)
  expect(uiState.get('shell.panel')).toBe('tasks')
  const shell = harness.writes.filter((write) => write.key.startsWith('shell.'))
  expect(shell.length).toBeGreaterThan(0)
  expect(new Set(shell.map((write) => write.who))).toEqual(new Set(['app']))
  openPanel()
  expect(regionOpen('panels')).toBe(true)
  expect(uiState.get('shell.panel')).toBe('tasks')
})
