import { createSignal, flush, Show } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { PromptBox } from '@/sdk/solid'
import type { DictationSink } from '@/sdk/solid'
import { registry } from '../../../../web/src/sdk/client.ts'
import { capture } from '../../capture.ts'
import { DictationShortcuts, setFallback, setTalkMode } from '../../routing.solid.tsx'
import dictation from '../../web.solid.tsx'

vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const fetch = async () => Response.json({ result: { available: true } })
  const store = createStore({ fetch })
  const api = createApi(store, { fetch })
  return {
    store,
    api,
    reads: createReads(api, store),
    registry: createRegistry(),
    uiState: createUiState(undefined),
  }
})

class FakeRecorder extends EventTarget {
  static isTypeSupported = () => true
  state = 'inactive'
  start() {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    this.dispatchEvent(new Event('stop'))
  }
}

beforeEach(async () => {
  setTalkMode('hold')
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
  })
  await registry.setLoaders({
    '/extensions/dictation/web.solid.tsx': async () => ({ default: dictation }),
  })
  vi.useFakeTimers()
})

afterEach(async () => {
  setTalkMode('tap')
  await capture.end()
  setFallback(undefined)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const sink = () => ({
  recording: vi.fn<() => void>(),
  finish: vi.fn<DictationSink['finish']>(async () => {}),
})

function mount(plain: DictationSink, main: DictationSink, voice?: DictationSink) {
  const submit = () => Promise.resolve()
  const [open, setOpen] = createSignal(false)
  const container = renderSolid(() => (
    <>
      <DictationShortcuts />
      <PromptBox
        draft={undefined}
        name="plain box"
        placeholder=""
        onSubmit={submit}
        dictation={plain}
      />
      <div data-ui="composer" data-composer-target="conversation">
        <PromptBox
          draft={undefined}
          name="main composer"
          placeholder=""
          onSubmit={submit}
          dictation={main}
        />
      </div>
      <Show when={open()}>
        <PromptBox
          draft={undefined}
          name="Voice dock"
          placeholder=""
          onSubmit={submit}
          dictation={voice}
        />
      </Show>
    </>
  ))
  const [plainEditor, mainEditor] = Array.from(container.querySelectorAll('textarea'))
  return { container, plainEditor, mainEditor, openVoice: () => setOpen(true) }
}

function key(type: 'keydown' | 'keyup', handled = true) {
  const event = new KeyboardEvent(type, {
    key: ' ',
    code: 'Space',
    ctrlKey: true,
    metaKey: true,
    shiftKey: true,
    cancelable: true,
    bubbles: true,
  })
  document.activeElement!.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(handled)
}

async function press() {
  key('keydown')
  await vi.advanceTimersByTimeAsync(0)
  flush()
}

async function release() {
  key('keyup')
  await vi.runOnlyPendingTimersAsync()
  flush()
}

it('records into the focused prompt box and finishes there even if focus moves before release', async () => {
  const plain = sink()
  const main = sink()
  const wake = vi.fn<() => void>()
  const fallback = sink()
  setFallback({ sink: fallback, wake })
  const { plainEditor, mainEditor } = mount(plain, main)
  plainEditor.focus()
  mainEditor.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
  await press()
  expect(plain.recording).toHaveBeenCalledOnce()
  mainEditor.focus()
  await release()
  expect(plain.finish).toHaveBeenCalledOnce()
  expect(main.recording).not.toHaveBeenCalled()
  expect(wake).not.toHaveBeenCalled()
})

it('a second tap finishes the shortcut-owned take after focus moves to another box', async () => {
  setTalkMode('tap')
  const plain = sink()
  const main = sink()
  const { plainEditor, mainEditor } = mount(plain, main)
  plainEditor.focus()
  await press()
  expect(plain.recording).toHaveBeenCalledOnce()
  key('keyup', false)

  mainEditor.focus()
  await press()
  expect(plain.finish).toHaveBeenCalledOnce()
  expect(main.recording).not.toHaveBeenCalled()
  expect(capture.talking()).toBe(false)
})

it('wakes the fallback before recording when no prompt box is focused', async () => {
  const plain = sink()
  const main = sink()
  const fallback = sink()
  const wake = vi.fn<() => void>()
  setFallback({ sink: fallback, wake })
  mount(plain, main)
  await press()
  expect(wake).toHaveBeenCalledExactlyOnceWith()
  expect(fallback.recording).toHaveBeenCalledOnce()
  expect(wake).toHaveBeenCalledBefore(fallback.recording)
  await release()
  expect(fallback.finish).toHaveBeenCalledOnce()
  expect(plain.recording).not.toHaveBeenCalled()
  expect(main.recording).not.toHaveBeenCalled()
})

it('the Voice dock can stop a take started by the unfocused shortcut', async () => {
  const plain = sink()
  const main = sink()
  const voice = { ...sink(), signal: new AbortController().signal }
  const { container, openVoice } = mount(plain, main, voice)
  setFallback({ sink: voice, wake: openVoice })
  await press()
  const stop = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Stop recording for Voice dock"]',
  )
  expect(stop).not.toBeNull()
  expect(container.querySelectorAll('button[data-dictation-cancel]')).toHaveLength(1)
  stop!.click()
  await vi.advanceTimersByTimeAsync(0)
  flush()
  expect(voice.finish).toHaveBeenCalledOnce()
  expect(plain.finish).not.toHaveBeenCalled()
  expect(main.finish).not.toHaveBeenCalled()
  await release()
  expect(voice.finish).toHaveBeenCalledOnce()
})

it('focuses and records into the main composer when neither focus nor fallback selects a box', async () => {
  const plain = sink()
  const main = sink()
  const { mainEditor } = mount(plain, main)
  await press()
  expect(document.activeElement).toBe(mainEditor)
  expect(main.recording).toHaveBeenCalledOnce()
  await release()
  expect(main.finish).toHaveBeenCalledOnce()
  expect(plain.recording).not.toHaveBeenCalled()
})
