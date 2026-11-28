import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { createRoot, createSignal, flush } from 'solid-js'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseConversationId, parseEntryId } from '../../../../lib/ids.shared.ts'
import type { StreamedView } from '../../../../shared/protocol.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { answerReadsWith, FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import type { JsonObject } from '@earendil-works/pi-durable'
import type { SideChatEndReason, SideChatSession } from '../../refs.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  actions: [] as { name: string; args: unknown; source: string | null }[],
  writes: [] as { key: string; who: string }[],
  refuse: new Set<string>(),
  forkable: true,
  statusGate: undefined as Promise<void> | undefined,
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
  const subscriptions = (harness.server = fakeSubscriptions(harness.sources))
  const fetch = answerReadsWith(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    const name = /^\/api\/extensions\/side-chat\/actions\/(\w+)$/.exec(path)?.[1]
    if (name === 'status') {
      await harness.statusGate
      return Response.json({
        result: { forkable: harness.forkable, route: 'text', transcribes: false },
      })
    }
    if (!name) return subscriptions.handle(path, init) ?? Response.json({ result: null })
    const { args } = JSON.parse(init!.body as string) as { args: unknown }
    harness.actions.push({
      name,
      args,
      source: new Headers(init!.headers).get('x-ultimate-source'),
    })
    if (harness.refuse.has(name))
      return Response.json({ error: `side-chat/${name}: No side chat is open` }, { status: 400 })
    return Response.json({ result: { conversation: 90 } })
  })
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

import { getDraft } from '../../../../web/src/app/drafts.ts'
import { regionOpen } from '../../../../web/src/sdk/actions.ts'
import { registry, store, uiState } from '../../../../web/src/sdk/client.ts'
import {
  closePanel,
  Composer,
  ExtensionName,
  openPanel,
  Panels,
} from '../../../../web/src/sdk/solid.ts'
import { capture } from '../../../dictation/capture.web.ts'
import { DictationShortcuts } from '../../../dictation/routing.solid.tsx'
import {
  composeIn,
  dock,
  playerState,
  sendTyped,
  setSideChatOpen,
  setSideChatSource,
  sideChatShown,
  sideChatSink,
  useSpeaking,
} from '../../dock.solid.tsx'
import type { TurnView } from '../../dock.solid.tsx'
import { speech } from '../../../read-aloud/ui.solid.tsx'
import { openSideChat, SideChatPanel, SideChatOverlay } from '../../panel.solid.tsx'
import { SideComposer } from '../../frame.solid.tsx'
import { PinnedQuestion } from '../../pinned.solid.tsx'
import { StoredTurn } from '../../turns.solid.tsx'

const agent = createAgent()
const ultimate = 44
const fork = parseConversationId(90)
const utterances: EventTarget[] = []

vi.stubGlobal('speechSynthesis', {
  cancel() {},
  speak(utterance: EventTarget) {
    utterances.push(utterance)
  },
  getVoices: () => [],
})
vi.stubGlobal('SpeechSynthesisUtterance', EventTarget)
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
  },
)

beforeEach(async ({ onTestFinished }) => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)',
    addEventListener() {},
    removeEventListener() {},
  }))
  harness.sources.length = 0
  harness.actions.length = 0
  harness.writes.length = 0
  harness.refuse.clear()
  harness.forkable = true
  harness.statusGate = undefined
  utterances.length = 0
  speech.stop()
  composeIn(undefined)
  setSideChatOpen(false)
  dock.setSideMode(false)
  uiState.receive({})
  store.start()
  onTestFinished(() => store.stop())
  harness.sources[0].open()
  harness.sources[0].send('conversations', [
    { id: parseConversationId(ultimate), busy: false, answerAt: 1 },
  ])
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

const ended = (reason: SideChatEndReason, summary?: string) => ({
  sessions: {
    [ultimate]: {
      last: {
        id: fork,
        endedAt: new Date('2026-11-28T09:41:00').getTime(),
        reason,
        handedOff: reason === 'handoff',
        ...(summary ? { summary } : {}),
      },
    },
  },
})

it('offers no box until the source is known, and opening it takes focus from the main box until then', async () => {
  const main = document.createElement('textarea')
  document.body.append(main)
  main.focus()
  const view = renderSolid(() => <SideChatPanel />)
  openSideChat()
  await settle()
  flush()
  expect(view.querySelector('textarea')).toBeNull()
  expect(document.activeElement).not.toBe(main)
  await root({ sessions: {} })
  expect(document.activeElement).toBe(view.querySelector('textarea'))
  main.remove()
})

it('on a phone, a control the person focuses while the source loads keeps focus', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)',
    addEventListener() {},
    removeEventListener() {},
  }))
  const control = document.createElement('button')
  document.body.append(control)
  const view = renderSolid(() => <SideChatPanel />)
  openSideChat()
  await settle()
  flush()
  control.focus()
  await root({ sessions: {} })
  expect(view.querySelector('textarea')).not.toBeNull()
  expect(document.activeElement).toBe(control)
  control.remove()
})

it('a folded phone sheet drops the transcript and keeps its handle, Close and box', async ({
  onTestFinished,
}) => {
  onTestFinished(() => uiState.set('ext.side-chat.sheet', 'rest'))
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)',
    addEventListener() {},
    removeEventListener() {},
  }))
  uiState.set('ext.side-chat.sheet', 'folded')
  const view = renderSolid(() => (
    <ExtensionName value="side-chat">
      <SideChatOverlay />
    </ExtensionName>
  ))
  await root({ sessions: { [ultimate]: { id: fork, startedAt: 1 } } })
  setSideChatOpen(true)
  flush()
  await settle()
  const sheet = view.querySelector('[data-side-chat-sheet="folded"]')!
  expect(sheet.querySelector('[data-side-chat-grabber]')).not.toBeNull()
  expect(sheet.querySelector('[aria-label="Close side chat"]')).not.toBeNull()
  expect(sheet.querySelector('textarea')).not.toBeNull()
  expect(sheet.querySelector('[data-ui="transcript"]')).toBeNull()
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
  await root(ended('handoff'))
  expect(line()).toContain('handed off · brief sent')
  expect(view.querySelector('[data-closing-line="handoff"]')).not.toBeNull()
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

it('Conversation mode lives in the settings popover, is on by default, and switching it is the person’s write', async () => {
  const view = renderSolid(() => <SideChatPanel />)
  await root({ sessions: {} })
  expect(dock.conversation()).toBe(true)
  expect(view.querySelector('header [aria-label="Conversation mode"]')).toBeNull()
  const result = await agent.act({
    steps: [
      { ref: 'Side chat settings', action: 'setOpen', args: [true] },
      { ref: 'Conversation mode', action: 'setChecked', args: [false] },
    ],
  })
  expect(result).toMatchObject({ ok: true })
  await uiState.flush()
  expect(dock.conversation()).toBe(false)
  expect(harness.writes).toContainEqual({ key: 'ext.side-chat.conversation', who: 'agent' })
  await expectDistinctAgentNames(agent)
  harness.writes.length = 0
  const toggle = document.querySelector<HTMLElement>('[aria-label="Conversation mode"]')!
  expect(toggle.closest('[aria-label="Side chat settings options"]')).not.toBeNull()
  expect(toggle.closest('label')?.parentElement?.textContent).toContain(
    'Your message sends when you stop speaking, and replies are read aloud.',
  )
  toggle.click()
  flush()
  await uiState.flush()
  expect(dock.conversation()).toBe(true)
  expect(harness.writes).toContainEqual({ key: 'ext.side-chat.conversation', who: 'person' })
})

it('a reply is read aloud on its own only while Conversation mode is on and the side chat is shown', async () => {
  const said = async (open: boolean, conversation: boolean) => {
    setSideChatOpen(open)
    dock.setConversation(conversation)
    speech.stop()
    const before = harness.actions.length
    await sendTyped(`asked with open ${open}, conversation ${conversation}`)
    const key = (
      harness.actions.slice(before).find((call) => call.name === 'turn')!.args as {
        key: string
      }
    ).key
    const [turns, setTurns] = createSignal({ turns: [] as TurnView[], busy: true })
    const dispose = createRoot((done) => {
      useSpeaking(turns, sideChatShown)
      return done
    })
    setTurns({
      turns: [
        {
          key,
          data: { key, text: 'hi', route: 'text' },
          replies: [],
          entries: [],
          live: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Here is a thought. And another one.' }],
          } as TurnView['replies'][number],
        },
      ],
      busy: true,
    })
    flush()
    const spoken = speech.state.get().key === key
    dispose()
    return spoken
  }
  await root({ sessions: { [ultimate]: { id: fork, startedAt: 1 } } })
  composeIn(fork)
  expect(await said(true, true)).toBe(true)
  expect(await said(true, false)).toBe(false)
  expect(await said(false, true)).toBe(false)
})

it.each(['typed', 'silent talk'] as const)(
  'a final handoff leaves its queued reply playing until the next side chat sends (%s), without stopping that fork',
  async (via) => {
    const view = renderSolid(() => (
      <ExtensionName value="side-chat">
        <SideChatOverlay />
      </ExtensionName>
    ))
    await root({ sessions: { [ultimate]: { id: fork, startedAt: 1 } } })
    setSideChatOpen(true)
    await settle()
    await sendTyped('Hand it off')
    const turn = harness.actions.find((call) => call.name === 'turn')!.args as { key: string }
    harness.server!.of(fork)!.send('view', {
      conversation: { id: fork },
      docs: {},
      entries: [
        { id: 8, kind: 'side-chat.turn', data: { ...turn, text: 'Hand it off', route: 'text' } },
        {
          id: 9,
          kind: 'pi.assistant',
          model: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'I handed it off. You can go back now.' }],
            },
          ],
        },
      ],
    } as unknown as StreamedView)
    await settle()
    expect(playerState()).toMatchObject({ key: turn.key, index: 0, playing: true })
    await root(ended('handoff'))
    expect(view.querySelector('[data-closing-line="handoff"]')).not.toBeNull()
    expect(playerState()).toMatchObject({ key: turn.key, index: 0, playing: true })
    utterances.at(-1)!.dispatchEvent(new Event('end'))
    flush()
    expect(playerState()).toMatchObject({ key: turn.key, index: 1, playing: true })
    const next = parseConversationId(91)
    await root({ sessions: { [ultimate]: { id: next, startedAt: 2 } } })
    composeIn(next)
    const before = harness.actions.length
    if (via === 'typed') await sendTyped('A new thought')
    else {
      sideChatSink.start!()
      sideChatSink.recording!()
      getDraft(next).set({ text: 'A new thought' })
      await sideChatSink.finish(
        { blob: new Blob(['a'], { type: 'audio/webm' }), seconds: 2, spoke: false, envelope: [] },
        false,
      )
    }
    expect(harness.actions.slice(before).map((call) => call.name)).toEqual(['turn'])
    expect(speech.state.get()).toMatchObject({ playing: false, paused: false })
  },
)

it('X stops the owned playback', async () => {
  renderSolid(() => (
    <ExtensionName value="side-chat">
      <SideChatOverlay />
    </ExtensionName>
  ))
  await root({ sessions: { [ultimate]: { id: fork, startedAt: 1 } } })
  setSideChatOpen(true)
  await settle()
  await sendTyped('Say something')
  const turn = harness.actions.find((call) => call.name === 'turn')!.args as { key: string }
  harness.server!.of(fork)!.send('view', {
    conversation: { id: fork },
    docs: {},
    entries: [
      { id: 8, kind: 'side-chat.turn', data: { ...turn, text: 'Say something', route: 'text' } },
      {
        id: 9,
        kind: 'pi.assistant',
        model: [{ role: 'assistant', content: [{ type: 'text', text: 'Here it is.' }] }],
      },
    ],
  } as unknown as StreamedView)
  await settle()
  expect(playerState()).toMatchObject({ key: turn.key, playing: true })
  expect(await agent.act({ steps: [{ ref: 'Close side chat', action: 'press' }] })).toMatchObject({
    ok: true,
  })
  expect(dock.open()).toBe(false)
  expect(speech.state.get()).toMatchObject({ playing: false, paused: false })
})

it('a docked side chat pops out as the floating window when Panels switches away, and only X hides it', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }))
  const view = renderSolid(() => (
    <ExtensionName value="side-chat">
      <SideChatOverlay />
    </ExtensionName>
  ))
  await root({ sessions: { [ultimate]: { id: fork, startedAt: 1 } } })
  uiState.set('shell.panel', 'tasks')
  await uiState.flush()
  setSideChatOpen(true)
  flush()
  await settle()
  await uiState.flush()
  expect(uiState.get('shell.panel')).toBe('side-chat')
  expect(view.querySelector('[data-side-chat-panel]')).toBeNull()
  harness.writes.length = 0
  openPanel('todos')
  flush()
  await settle()
  await uiState.flush()
  expect(uiState.get('shell.panel')).toBe('todos')
  expect(regionOpen('panels')).toBe(true)
  expect(view.querySelector('[data-side-chat-panel]')).not.toBeNull()
  expect(harness.writes.filter((write) => write.key.startsWith('shell.'))).toEqual([
    { key: 'shell.panel', who: 'person' },
  ])
  await expectDistinctAgentNames(agent)
  expect(await agent.act({ steps: [{ ref: 'Close side chat', action: 'press' }] })).toMatchObject({
    ok: true,
  })
  flush()
  await settle()
  expect(dock.open()).toBe(false)
  expect(view.querySelector('[data-side-chat-panel]')).toBeNull()
  expect(uiState.get('shell.panel')).toBe('todos')
  closePanel()
  await uiState.flush()
})

it('re-selecting Side chat in Panels leaves exactly one docked copy', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(min-width: 1280px)',
    addEventListener() {},
    removeEventListener() {},
  }))
  await registry.setLoaders({
    '/extensions/side-chat/web.solid.tsx': async () => ({
      default: {
        panels: [{ id: 'side-chat', title: 'Side chat', component: SideChatPanel, tab: false }],
      },
    }),
  })
  const view = renderSolid(() => (
    <ExtensionName value="side-chat">
      <Panels />
      <SideChatOverlay />
    </ExtensionName>
  ))
  await root({ sessions: { [ultimate]: { id: fork, startedAt: 1 } } })
  const copies = () => [...view.querySelectorAll('[data-side-chat-panel]')]
  setSideChatOpen(true)
  await settle()
  expect(copies()).toEqual([view.querySelector('[data-side-chat-docked]')])
  openPanel('todos')
  await settle()
  expect(copies()).toHaveLength(1)
  expect(copies()[0].hasAttribute('data-side-chat-docked')).toBe(false)
  openPanel('side-chat')
  await settle()
  expect(copies()).toEqual([view.querySelector('[data-side-chat-docked]')])
  await expectDistinctAgentNames(agent)
  closePanel()
  await uiState.flush()
  await registry.setLoaders({})
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

it('waits for status and offers no switch or box when the only assistant entry is a tool call', async () => {
  const status = Promise.withResolvers<void>()
  harness.statusGate = status.promise
  harness.forkable = false
  const source = parseConversationId(45)
  harness.sources[0].send('conversations', [{ id: source, busy: true, answerAt: 1 }])
  store.show(source)
  await settle()
  harness.server!.of(source)!.send('view', {
    conversation: { id: source },
    entries: [],
    docs: {},
  })
  const frame = renderSolid(() => <SideComposer core={<textarea id="composer-input" />} />)
  const panel = renderSolid(() => <SideChatPanel />)
  await root({ sessions: {} }, { 'ultimate.standing-agents': { ultimate: source } })
  expect(frame.querySelector('[data-side-mode]')).toBeNull()
  expect(panel.querySelector('textarea')).toBeNull()
  expect(panel.querySelector('[data-side-chat-unforkable]')).toBeNull()
  status.resolve()
  await settle()
  expect(frame.querySelector('[data-side-mode]')).toBeNull()
  expect(panel.querySelector('textarea')).toBeNull()
  expect(panel.querySelector('[data-side-chat-unforkable]')?.textContent).toBe(
    '@ultimate has no finished reply to fork yet',
  )
  harness.forkable = true
  harness.sources[0].send('conversations', [{ id: source, busy: false, answerAt: 1 }])
  await settle()
  expect(frame.querySelector('[data-side-mode]')?.getAttribute('data-side-mode')).toBe('normal')
  expect(panel.querySelector('textarea')).not.toBeNull()
})

it('Talk is not advertised and its fallback cannot start a take while the source is unforkable', async () => {
  harness.forkable = false
  const press = vi.spyOn(capture, 'press').mockReturnValue(undefined)
  const view = renderSolid(() => (
    <ExtensionName value="side-chat">
      <DictationShortcuts />
      <SideChatOverlay />
    </ExtensionName>
  ))
  const talk = () =>
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: ' ',
        code: 'Space',
        ctrlKey: true,
        shiftKey: true,
        cancelable: true,
        bubbles: true,
      }),
    )
  try {
    await root({ sessions: {} })
    setSideChatOpen(true)
    await settle()
    expect(view.querySelector('[data-side-chat-unforkable]')).not.toBeNull()
    expect(view.textContent).not.toContain('to speak')
    talk()
    expect(press).not.toHaveBeenCalled()
    harness.forkable = true
    harness.sources[0].send('conversations', [
      { id: parseConversationId(ultimate), busy: false, answerAt: 2 },
    ])
    await settle()
    expect(view.textContent).toContain('to speak')
    talk()
    expect(press).toHaveBeenCalledExactlyOnceWith(sideChatSink)
    press.mockClear()
    harness.forkable = false
    harness.sources[0].send('conversations', [{ id: parseConversationId(ultimate), busy: false }])
    await root({ sessions: { [ultimate]: { id: fork, startedAt: 1, question: 5 } } })
    talk()
    expect(press).toHaveBeenCalledExactlyOnceWith(sideChatSink)
  } finally {
    press.mockRestore()
  }
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
