/** @jsxImportSource @solidjs/web */
import type { EntryRecord } from '@earendil-works/pi-durable'
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import type { ToolCallView } from '@/sdk'
import { Transcript, createTranscriptFrame, events } from '@/sdk/solid'
import { parseConversationId, parseEntryId } from '../../../../lib/ids.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import type { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { shellKeys } from '../../../../web/src/sdk/actions.ts'
import * as client from '../../../../web/src/sdk/client.ts'
import { writerNow } from '../../../../web/src/sdk/writer.ts'
import { MessageReference, provide } from '../../../../web/src/sdk/types.ts'
import { Bubble } from '../../bubble.solid.tsx'
import { MessagesDoc } from '../../refs.ts'
import type { Message } from '../../refs.ts'
import { MessageCall } from '../../tool-cards.solid.tsx'

const sources = vi.hoisted(() => [] as FakeSource[])
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { FakeSource, fakeSubscriptions } = await import('../../../../test/web/fake-source.ts')
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const server = fakeSubscriptions(sources)
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) =>
    server.handle(input as string, init) ?? Response.json({ entries: [] })
  const store = createStore({
    eventSource: (url) => {
      const source = new FakeSource(url)
      sources.push(source)
      return source
    },
    fetch,
  })
  return {
    api: { history: vi.fn<typeof client.api.history>() },
    reportCompact: () => undefined,
    store,
    uiState: createUiState(undefined),
    registry: createRegistry(),
    server,
  }
})
const { store, uiState, server } = client as typeof client & {
  server: ReturnType<typeof fakeSubscriptions>
}
const sender = parseConversationId(43)
const recipient = parseConversationId(12)
const imageEntry = parseEntryId(9)
const message: Message = {
  id: 1,
  from: sender,
  to: 'user',
  text: 'Look',
  at: 0,
  reply: false,
  state: 'delivered',
}
const agent = createAgent()

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  store.start()
  sources.at(-1)!.open()
})
afterEach(() => {
  store.stop()
  vi.unstubAllGlobals()
})

it('shows a forwarded screenshot as a zoomable thumbnail from the loaded transcript', async () => {
  const shot = {
    id: imageEntry,
    conversationId: sender,
    kind: 'pi.tool-result',
    model: [
      { role: 'toolResult', content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
    ],
  } as unknown as EntryRecord
  const transcript = createTranscriptFrame([shot])
  const view = renderSolid(() => (
    <Transcript value={transcript.frame}>
      <Bubble
        from={sender}
        message={{ ...message, images: { entry: imageEntry, count: 1 } }}
        running={false}
        text="Look"
      />
    </Transcript>
  ))
  expect(view.querySelector('img[alt="Forwarded image 1"]')?.getAttribute('src')).toBe(
    'data:image/png;base64,AAAA',
  )
  expect(view.querySelector('[role="dialog"][data-open]')).toBeNull()
  view.querySelector<HTMLButtonElement>('button[aria-label="Zoom Forwarded image 1"]')!.click()
  await settle()
  expect(view.querySelector('[role="dialog"][data-open] img')?.getAttribute('src')).toBe(
    'data:image/png;base64,AAAA',
  )
  expect(client.api.history).not.toHaveBeenCalled()
})

it('opens the delivered message in the recipient conversation from the agent control', async () => {
  const call: ToolCallView = {
    id: 'post-1',
    name: 'message',
    args: { to: '#12', text: message.text },
    status: 'done',
    output: 'Message 1 sent.',
    diagnostics: [],
    images: [],
  }
  const received = vi.fn<(value: unknown, writer: string) => void>()
  const entry = parseEntryId(54)
  onTestFinished(events.on('messages:open', (value) => received(value, writerNow())))
  uiState.set(shellKeys.conversation, sender)
  uiState.set(shellKeys.surface, 'inbox')
  const view = renderSolid(() => <MessageCall call={call} core={null} />)
  await settle()
  server.of(1)!.send('doc', {
    kind: MessagesDoc.kind,
    value: { next: 2, messages: [{ ...message, to: recipient, entry }] },
  })
  flush()
  await settle()

  expect(view.querySelector('[data-message-outgoing="1"]')?.textContent).toContain(message.text)
  await expectDistinctAgentNames(agent)
  const open = agent
    .snapshot()
    .find((control) => !control.offPage && control.label === "Open #12's message 1")
  const result = await agent.act({ steps: [{ ref: open!.ref, action: 'press' }] })
  expect(result.ok).toBe(true)
  expect(uiState.get(shellKeys.conversation)).toBe(recipient)
  expect(uiState.get(shellKeys.surface)).toBe('agent')
  expect(received).toHaveBeenCalledExactlyOnceWith({ conversation: recipient, entry }, 'agent')
})

it('names each bubble of one codemode script by its board message, so an agent can copy either', async () => {
  const script = {
    id: parseEntryId(54),
    conversationId: sender,
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [], timestamp: 0 }],
  } as unknown as EntryRecord
  await client.registry.setLoaders({
    'extensions/codemode/web.tsx': async () => ({
      default: { provides: [provide(MessageReference, ({ id }) => `#43/${id}`)] },
    }),
  })
  renderSolid(() => (
    <>
      <Bubble entry={script} from={sender} message={message} running={false} text="One" />
      <Bubble
        entry={script}
        from={sender}
        message={{ ...message, id: 2 }}
        running={false}
        text="Two"
      />
    </>
  ))
  flush()
  await settle()
  const labels = agent.snapshot().map((entry) => entry.label)
  expect(labels.filter((label) => label?.startsWith('Copy board'))).toHaveLength(2)
  expect(labels.filter((label) => label?.startsWith('Copy reference to board'))).toHaveLength(2)
  await expectDistinctAgentNames(agent)
})
