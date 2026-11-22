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
  const { answerReadsWith } = await import('../../../../test/web/fake-source.ts')
  const pageFetch = answerReadsWith(fetch)
  const store = createStore({
    eventSource: (url) => {
      const source = new FakeSource(url)
      harness.sources.push(source)
      return source
    },
    fetch: pageFetch,
  })
  const api = createApi(store, { fetch: pageFetch })
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
  getUserMedia.mockReset()
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('Blob', NodeBlob)
  clientStore.start()
  onTestFinished(() => clientStore.stop())
  harness.sources[0].open()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function showConversation(id: number) {
  const conversation = parseConversationId(id)
  clientStore.show(conversation)
  await settle()
  const view = {
    conversation: { id: conversation },
    entries: [],
    docs: {},
  } as StreamedView
  harness.server!.of(id)!.send('view', view)
  flush()
}

async function mount(id: number, status: VoiceStatus) {
  harness.status = status
  await showConversation(id)
  const container = renderSolid(() => <VoiceButton />)
  await settle()
  flush()
  return container
}

async function press(label: string) {
  const control = agent.snapshot().find((entry) => !entry.offPage && entry.label === label)
  expect(control).toMatchObject({ component: 'button', label })
  const result = agent.act({ steps: [{ ref: control!.ref, action: 'press' }] })
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(100)
  expect(await result).toMatchObject({ ok: true })
  if (!vi.isFakeTimers()) await settle()
  flush()
}

function expectPointerDownPrevented(container: HTMLElement, label: string) {
  const button = container.querySelector(`button[aria-label="${label}"]`)
  expect(button).not.toBeNull()
  const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
  button!.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
}

it('opens the key’s Secrets row when the blocked mic is pressed', async ({ onTestFinished }) => {
  const reason = 'Voice needs an OpenAI API key: add OPENAI_API_KEY in ⌘K → Secrets'
  const opened = vi.fn<(data: unknown) => void>()
  onTestFinished(events.on('secrets:open', opened))
  const container = await mount(7, { available: false, reason })
  const mic = container.querySelector('button[data-voice="blocked"]')
  expect(mic?.getAttribute('aria-label')).toBe(reason)
  expect(mic?.getAttribute('aria-disabled')).toBeNull()
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

it('records for an agent and transcribes into the same composer, leaving the editor focused', async ({
  onTestFinished,
}) => {
  const container = await mount(8, { available: true })
  const editor = document.body.appendChild(document.createElement('textarea'))
  onTestFinished(() => editor.remove())
  editor.focus()
  expectPointerDownPrevented(container, 'Voice input')
  await press('Voice input')
  expect(getUserMedia).toHaveBeenCalledTimes(1)
  expectPointerDownPrevented(container, 'Cancel recording')
  expectPointerDownPrevented(container, 'Stop and transcribe')
  expect(document.activeElement).toBe(editor)
  await expectDistinctAgentNames(agent)
  await press('Stop and transcribe')
  expect(document.activeElement).toBe(editor)
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

it('releases a late microphone stream without transcribing after a conversation switch', async () => {
  const permission = Promise.withResolvers<Awaited<ReturnType<typeof microphone>>>()
  getUserMedia.mockReturnValueOnce(permission.promise)
  const container = await mount(9, { available: true })
  const pressed = press('Voice input')
  await settle()
  expect(getUserMedia).toHaveBeenCalledTimes(1)

  await showConversation(10)

  const stopOtherTrack = vi.fn<() => void>()
  permission.resolve({ getTracks: () => [{ stop: stopTrack }, { stop: stopOtherTrack }] })
  await pressed
  expect(stopTrack).toHaveBeenCalledTimes(1)
  expect(stopOtherTrack).toHaveBeenCalledTimes(1)
  expect(container.querySelector('button[data-voice="idle"]')).not.toBeNull()
  expect(harness.transcribe).not.toHaveBeenCalled()
})

it('stops and transcribes automatically after five minutes', async () => {
  const container = await mount(11, { available: true })
  vi.useFakeTimers()
  let startedAt = Date.now()
  getUserMedia.mockImplementationOnce(() => {
    startedAt = Date.now()
    return microphone()
  })
  await press('Voice input')

  await vi.advanceTimersByTimeAsync(startedAt + 5 * 60_000 - Date.now() - 1)
  flush()
  expect(container.querySelector('button[aria-label="Stop and transcribe"]')).not.toBeNull()
  expect(stopTrack).not.toHaveBeenCalled()
  expect(harness.transcribe).not.toHaveBeenCalled()

  await vi.advanceTimersByTimeAsync(1)
  flush()
  expect(stopTrack).toHaveBeenCalledTimes(1)
  expect(harness.transcribe).toHaveBeenCalledExactlyOnceWith(
    {
      args: { audio: 'YXVkaW8=', mimeType: 'audio/webm;codecs=opus' },
      conversationId: 11,
    },
    'app',
  )
  expect(getDraft(11).get().text).toBe('hello from the mic')
})

it('shows a microphone permission alert for eight seconds', async () => {
  const container = await mount(12, { available: true })
  vi.useFakeTimers()
  let deniedAt = Date.now()
  getUserMedia.mockImplementationOnce(async () => {
    deniedAt = Date.now()
    throw new DOMException('Permission denied', 'NotAllowedError')
  })
  await press('Voice input')

  const alert = () => container.querySelector('[role="alert"]')
  expect(alert()?.textContent).toBe(
    'Microphone access is blocked: allow it in the browser’s site settings',
  )
  await vi.advanceTimersByTimeAsync(deniedAt + 8000 - Date.now() - 1)
  flush()
  expect(alert()).not.toBeNull()
  await vi.advanceTimersByTimeAsync(1)
  flush()
  expect(alert()).toBeNull()
})

it('tells an Android system block apart from a blocked site', async () => {
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia },
    userAgent: 'Mozilla/5.0 (Linux; Android 15)',
  })
  const container = await mount(13, { available: true })
  const deny = (message: string) =>
    getUserMedia.mockImplementationOnce(async () => {
      throw new DOMException(message, 'NotAllowedError')
    })
  const alert = () => container.querySelector('[role="alert"]')?.textContent

  deny('Permission denied by system')
  await press('Voice input')
  expect(alert()).toBe(
    'Android blocks the mic for Chrome: allow it in Settings → Apps → Chrome → Permissions',
  )
  deny('Permission denied')
  await press('Voice input')
  expect(alert()).toBe(
    'Mic blocked for this site: allow it in Chrome → Settings → Site settings → Microphone',
  )
})

it('spaces inserted words from their neighbours and puts the cursor after them', () => {
  expect(spliced('', 0, 0, 'Hello')).toEqual({ text: 'Hello', cursor: 5 })
  expect(spliced('Fix the', 7, 7, 'login bug')).toEqual({ text: 'Fix the login bug', cursor: 17 })
  expect(spliced('Fix bug', 3, 3, 'the')).toEqual({ text: 'Fix the bug', cursor: 7 })
  expect(spliced('Fixbug', 3, 3, 'the')).toEqual({ text: 'Fix the bug', cursor: 8 })
  expect(spliced('Fix  bug', 4, 4, 'the')).toEqual({ text: 'Fix the bug', cursor: 7 })
  expect(spliced('Fix XXX bug', 4, 7, 'the')).toEqual({ text: 'Fix the bug', cursor: 7 })
})
