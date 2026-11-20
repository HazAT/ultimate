/** @jsxImportSource @solidjs/web */
import { Blob as NodeBlob } from 'node:buffer'
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.ts'
import type { StreamedView } from '../../../../shared/protocol.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { getDraft } from '../../../../web/src/app/drafts.ts'
import { spliced } from '../../../../web/src/app/queued.ts'
import { store as clientStore } from '../../../../web/src/sdk/client.ts'
import { events } from '@/sdk/solid'
import { VoiceButton } from '../../button.solid.tsx'
import type { VoiceStatus } from '../../refs.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  status: { available: true } as VoiceStatus,
  transcribe: vi.fn<(request: unknown, source: string | null) => void>(),
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const subscriptions = (harness.server = fakeSubscriptions(harness.sources))
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    if (path === '/api/extensions/voice/actions/status')
      return Response.json({ result: harness.status })
    if (path === '/api/extensions/voice/actions/transcribe') {
      harness.transcribe(
        JSON.parse(init?.body as string),
        new Headers(init?.headers).get('x-ultimate-source'),
      )
      return Response.json({ result: { text: 'hello from the mic' } })
    }
    return subscriptions.handle(path, init) ?? Response.json({ ok: true })
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
  return { store, api, reads: createReads(api, store), uiState: createUiState(undefined) }
})

class FakeRecorder extends EventTarget {
  static isTypeSupported = () => true
  mimeType = 'audio/webm;codecs=opus'
  state = 'inactive'
  start() {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    queueMicrotask(() => {
      this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob(['audio']) }))
      this.dispatchEvent(new Event('stop'))
    })
  }
}

const agent = createAgent()
const stopTrack = vi.fn<() => void>()
const microphone = async () => ({ getTracks: () => [{ stop: stopTrack }] })
const getUserMedia = vi.fn<typeof microphone>(microphone)

beforeEach(({ onTestFinished }) => {
  harness.sources.length = 0
  vi.clearAllMocks()
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('Blob', NodeBlob)
  clientStore.start()
  onTestFinished(() => clientStore.stop())
  harness.sources[0].open()
})
afterEach(() => vi.unstubAllGlobals())

async function mount(id: number, status: VoiceStatus) {
  harness.status = status
  const view = {
    conversation: { id: parseConversationId(id) },
    entries: [],
    docs: {},
  } as StreamedView
  harness.server!.of()!.send('view', view)
  const container = renderSolid(() => <VoiceButton />)
  await settle()
  flush()
  return container
}

async function press(label: string) {
  const control = agent.snapshot().find((entry) => !entry.offPage && entry.label === label)
  expect(control).toMatchObject({ component: 'button', label })
  expect(await agent.act({ steps: [{ ref: control!.ref, action: 'press' }] })).toMatchObject({
    ok: true,
  })
  await settle()
  flush()
}

it('dims the mic and opens the key’s Secrets row when pressed', async ({ onTestFinished }) => {
  const reason = 'Voice needs an OpenAI API key: add OPENAI_API_KEY in ⌘K → Secrets'
  const opened = vi.fn<(data: unknown) => void>()
  onTestFinished(events.on('secrets:open', opened))
  const container = await mount(7, { available: false, reason })
  const mic = container.querySelector('button[data-voice="blocked"]')
  expect(mic?.getAttribute('aria-label')).toBe(reason)
  expect(mic?.classList.contains('data-[voice=blocked]:opacity-50')).toBe(true)
  await press(reason)
  expect(opened).toHaveBeenCalledExactlyOnceWith({ name: 'OPENAI_API_KEY' })
  expect(getUserMedia).not.toHaveBeenCalled()

  harness.status = { available: true }
  events.emit('secrets:changed', undefined)
  await settle()
  flush()
  expect(container.querySelector('button[data-voice="idle"]')?.getAttribute('aria-label')).toBe(
    'Voice input',
  )
})

it('records for an agent and transcribes into the same composer', async () => {
  const container = await mount(8, { available: true })
  await press('Voice input')
  expect(getUserMedia).toHaveBeenCalledTimes(1)
  expect(container.querySelector('button[aria-label="Cancel recording"]')).not.toBeNull()
  await expectDistinctAgentNames(agent)
  await press('Stop and transcribe')
  expect(stopTrack).toHaveBeenCalledTimes(1)
  expect(harness.transcribe).toHaveBeenCalledExactlyOnceWith(
    {
      args: { audio: 'YXVkaW8=', mimeType: 'audio/webm;codecs=opus' },
      conversationId: 8,
    },
    'agent',
  )
  expect(getDraft(8).get().text).toBe('hello from the mic')
})

it('spaces inserted words from their neighbours and puts the cursor after them', () => {
  expect(spliced('', 0, 0, 'Hello')).toEqual({ text: 'Hello', cursor: 5 })
  expect(spliced('Fix the', 7, 7, 'login bug')).toEqual({ text: 'Fix the login bug', cursor: 17 })
  expect(spliced('Fix bug', 3, 3, 'the')).toEqual({ text: 'Fix the bug', cursor: 7 })
  expect(spliced('Fixbug', 3, 3, 'the')).toEqual({ text: 'Fix the bug', cursor: 8 })
  expect(spliced('Fix  bug', 4, 4, 'the')).toEqual({ text: 'Fix the bug', cursor: 7 })
  expect(spliced('Fix XXX bug', 4, 7, 'the')).toEqual({ text: 'Fix the bug', cursor: 7 })
})
