import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { createRoot, createSignal, flush, Show } from 'solid-js'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import { PromptBox } from '@/sdk/solid'
import { beforeEach, expect, it, vi } from 'vitest'
import type { UltimateContext } from '@/sdk/solid'
import { parseConversationId } from '../../../../lib/ids.shared.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { installShortcuts } from '../../../../web/src/app/keyboard.ts'
import { registry } from '../../../../web/src/sdk/client.ts'
import { capture } from '../../../dictation/capture.web.ts'
import { DictationShortcuts } from '../../../dictation/routing.solid.tsx'
import { recordButton } from '../../button.solid.tsx'
import { createScreenRecorder } from '../../capture.web.ts'

class FakeTrack extends EventTarget {
  stopped = false
  readonly kind: 'audio' | 'video'
  constructor(kind: 'audio' | 'video') {
    super()
    this.kind = kind
  }
  get readyState() {
    return this.stopped ? 'ended' : 'live'
  }
  stop() {
    this.stopped = true
  }
  end() {
    this.stopped = true
    this.dispatchEvent(new Event('ended'))
  }
}
class FakeStream {
  readonly tracks: FakeTrack[]
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = tracks
  }
  getTracks = () => this.tracks
  getAudioTracks = () => this.tracks.filter((track) => track.kind === 'audio')
  getVideoTracks = () => this.tracks.filter((track) => track.kind === 'video')
}
class FakeRecorder extends EventTarget {
  static isTypeSupported = (type: string) => type === 'video/webm;codecs=vp9,opus'
  static last: FakeRecorder | undefined
  static failStart = false
  static later: (() => void) | undefined
  state = 'inactive'
  readonly stream: FakeStream
  readonly options: { mimeType?: string }
  constructor(stream: FakeStream, options: { mimeType?: string }) {
    super()
    this.stream = stream
    this.options = options
    FakeRecorder.last = this
  }
  get mimeType() {
    return this.options.mimeType ?? ''
  }
  start() {
    if (FakeRecorder.failStart) throw new DOMException('no encoder', 'NotSupportedError')
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    const finish = () => {
      this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob(['frames']) }))
      this.dispatchEvent(new Event('stop'))
    }
    if (FakeRecorder.async) FakeRecorder.later = finish
    else finish()
  }
  static async = false
}
class FakeAudio {
  static closed = 0
  static mixed: FakeTrack[] = []
  createMediaStreamDestination = () => {
    const track = new FakeTrack('audio')
    FakeAudio.mixed.push(track)
    return { stream: new FakeStream([track]) }
  }
  createMediaStreamSource = () => ({ connect: () => undefined })
  close() {
    FakeAudio.closed++
    return Promise.resolve()
  }
}

const agent = createAgent()
let screen: FakeStream
let mic: FakeStream
const display = vi.fn<() => Promise<MediaStream>>()
const microphone = vi.fn<() => Promise<MediaStream>>()
const released = vi.fn<() => void>()
const attached: { box: string; draft: unknown; files: File[] }[] = []
const marks: boolean[] = []
let accepts = true
let upload: Promise<void> = Promise.resolve()

beforeEach(() => {
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('MediaStream', FakeStream)
  vi.stubGlobal('AudioContext', FakeAudio)
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('File', NodeFile)
  screen = new FakeStream([new FakeTrack('video'), new FakeTrack('audio')])
  mic = new FakeStream([new FakeTrack('audio')])
  display.mockReset().mockImplementation(async () => screen as unknown as MediaStream)
  microphone.mockReset().mockImplementation(async () => mic as unknown as MediaStream)
  released.mockReset()
  attached.length = 0
  marks.length = 0
  accepts = true
  upload = Promise.resolve()
  FakeAudio.closed = 0
  FakeAudio.mixed = []
  FakeRecorder.last = undefined
  FakeRecorder.failStart = false
  FakeRecorder.async = false
  FakeRecorder.later = undefined
})

type Spec = { name: string; draft: number; shown?: () => boolean }

function mount(...specs: Spec[]) {
  const recorder = createScreenRecorder({
    display,
    mic: microphone,
    hold: () => released,
    now: () => 0,
  })
  const Button = recordButton(recorder, () => true)
  const box = (spec: Spec) => (
    <Button
      attach={(files) => {
        if (!accepts) return Promise.resolve(false)
        attached.push({ box: spec.name, draft: spec.draft, files: [...files] })
        return upload.then(() => true)
      }}
      draft={spec.draft}
      name={spec.name}
      recording={(on) => marks.push(on)}
    />
  )
  const container = renderSolid(() =>
    specs.map((spec) => <Show when={spec.shown?.() ?? true}>{box(spec)}</Show>),
  )
  flush()
  return { container, recorder }
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

const allStopped = () =>
  [...screen.tracks, ...mic.tracks, ...FakeAudio.mixed].every((track) => track.stopped)

it('records screen and mic into one webm and attaches it to the box it was stopped from', async () => {
  const { container } = mount({ name: 'box A', draft: 1 }, { name: 'box B', draft: 2 })
  await press('Record the screen into box A')
  expect(display).toHaveBeenCalledOnce()
  expect(FakeRecorder.last?.mimeType).toBe('video/webm;codecs=vp9,opus')
  expect(FakeRecorder.last?.stream.getVideoTracks()).toEqual(screen.getVideoTracks())
  expect(FakeRecorder.last?.stream.getAudioTracks()).toHaveLength(1)
  expect(container.textContent).toContain('screen + mic')
  expect(marks.at(-1)).toBe(true)

  await press('Stop and attach the screen recording to box B')
  expect(attached.map((entry) => entry.box)).toEqual(['box B'])
  expect(attached[0].files[0]).toMatchObject({ type: 'video/webm' })
  expect(attached[0].files[0].name).toMatch(/^Screen recording .+\.webm$/)
  expect(allStopped()).toBe(true)
  expect(FakeAudio.closed).toBe(1)
  expect(marks.at(-1)).toBe(false)
})

it('holds a waiting page reload until the recording’s upload has settled', async () => {
  const done = Promise.withResolvers<void>()
  upload = done.promise
  mount({ name: 'box A', draft: 1 })
  await press('Record the screen into box A')
  await press('Stop and attach the screen recording to box A')
  expect(attached).toHaveLength(1)
  expect(released).not.toHaveBeenCalled()
  done.resolve()
  await settle()
  expect(released).toHaveBeenCalledOnce()
})

it('Stop sharing from the browser attaches to the draft that started it, even after a switch away', async () => {
  const [shown, setShown] = createRoot(() => createSignal(true))
  mount({ name: 'box A', draft: 1, shown }, { name: 'box B', draft: 2 })
  await press('Record the screen into box A')
  setShown(false)
  flush()
  screen.getVideoTracks()[0].end()
  await settle()
  expect(attached).toEqual([])
  expect(released).not.toHaveBeenCalled()
  setShown(true)
  flush()
  await settle()
  expect(attached.map((entry) => entry.draft)).toEqual([1])
  expect(released).toHaveBeenCalledOnce()
})

it('keeps a recording a busy box refused until that box takes it', async () => {
  const { recorder } = mount({ name: 'box A', draft: 1 })
  await press('Record the screen into box A')
  accepts = false
  await press('Stop and attach the screen recording to box A')
  expect(attached).toEqual([])
  expect(released).not.toHaveBeenCalled()
  accepts = true
  recorder.mount({
    draft: 1,
    attach: async (files) => (attached.push({ box: 'again', draft: 1, files: [...files] }), true),
  })
  await settle()
  expect(attached.map((entry) => entry.box)).toEqual(['again'])
  expect(released).toHaveBeenCalledOnce()
})

it('discards on Cancel and on Escape: nothing attaches and every track is released', async () => {
  mount({ name: 'box A', draft: 1 })
  await press('Record the screen into box A')
  await press('Cancel the screen recording in box A')
  expect(attached).toEqual([])
  expect(allStopped()).toBe(true)
  expect(released).toHaveBeenCalledOnce()

  screen = new FakeStream([new FakeTrack('video')])
  mic = new FakeStream([new FakeTrack('audio')])
  await press('Record the screen into box A')
  const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
  document.body.dispatchEvent(escape)
  flush()
  expect(escape.defaultPrevented).toBe(true)
  expect(attached).toEqual([])
  expect(allStopped()).toBe(true)
  expect(released).toHaveBeenCalledTimes(2)
})

it('Escape in a busy composer cancels the newest of dictation and screen recording, then the other, then stops the run', async ({
  onTestFinished,
}) => {
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: async () => new FakeStream([new FakeTrack('audio')]) },
  })
  const stopRun = vi.fn<() => void>()
  const busyId = parseConversationId(7)
  await registry.setLoaders({
    '/extensions/agent/web.solid.tsx': async () => ({
      default: {
        commands: [
          {
            id: 'agent.stop',
            title: 'Stop the run',
            keys: 'escape',
            whileTyping: true,
            when: (context: UltimateContext) => context.conversationId === busyId,
            run: stopRun,
          },
        ],
      },
    }),
  })
  const uninstall = installShortcuts()
  onTestFinished(async () => {
    uninstall()
    await registry.setLoaders({})
    await capture.end()
    vi.unstubAllGlobals()
  })
  const composer = renderSolid(() => (
    <div data-composer-target="conversation" data-conversation-scope={busyId}>
      <DictationShortcuts />
      <textarea aria-label="Busy composer" />
    </div>
  )).querySelector('textarea')!
  composer.focus()
  const { recorder } = mount({ name: 'box A', draft: 1 })
  await press('Record the screen into box A')
  vi.stubGlobal('AudioContext', undefined)
  const sink = { cancel: vi.fn<() => void>(), finish: vi.fn<() => Promise<void>>(async () => {}) }
  const dictation = capture.press(sink)!
  await dictation.started
  expect(recorder.state().phase).toBe('recording')
  expect(capture.capturing(sink)).toBe(true)

  const escape = (type: 'keydown' | 'keyup' = 'keydown', repeat = false) =>
    composer.dispatchEvent(
      new KeyboardEvent(type, { key: 'Escape', cancelable: true, bubbles: true, repeat }),
    )
  expect(escape()).toBe(false)
  expect(dictation.active()).toBe(false)
  await settle()
  flush()
  expect(sink.cancel).toHaveBeenCalledOnce()
  expect(sink.finish).not.toHaveBeenCalled()
  expect(recorder.state().phase).toBe('recording')
  expect(stopRun).not.toHaveBeenCalled()

  expect(escape('keydown', true)).toBe(false)
  expect(recorder.state().phase).toBe('recording')
  escape('keyup')
  expect(escape()).toBe(false)
  flush()
  expect(recorder.state().phase).toBe('idle')
  expect(attached).toEqual([])
  await settle()
  expect(stopRun).not.toHaveBeenCalled()

  escape('keyup')
  expect(escape()).toBe(false)
  await settle()
  expect(stopRun).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ conversationId: busyId }),
  )
})

it('Escape in a prompt box whose own Escape blurs it cancels a recording first, and only a new press reaches the box', async ({
  onTestFinished,
}) => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  onTestFinished(() => {
    vi.unstubAllGlobals()
  })
  const blurred = vi.fn<() => void>()
  const field = renderSolid(() => (
    <PromptBox
      draft={undefined}
      name="note"
      placeholder=""
      onSubmit={() => Promise.resolve()}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return false
        event.preventDefault()
        blurred()
        return true
      }}
    />
  )).querySelector('textarea')!
  const { recorder } = mount({ name: 'box A', draft: 1 })
  await press('Record the screen into box A')
  field.focus()
  const escape = (type: 'keydown' | 'keyup', repeat = false) =>
    field.dispatchEvent(
      new KeyboardEvent(type, { key: 'Escape', cancelable: true, bubbles: true, repeat }),
    )
  escape('keydown')
  flush()
  expect(recorder.state().phase).toBe('idle')
  escape('keydown', true)
  escape('keydown', true)
  expect(blurred).not.toHaveBeenCalled()
  escape('keyup')
  escape('keydown')
  expect(blurred).toHaveBeenCalledOnce()
})

it('a held Escape that discarded a screen recording closes no popup beneath it and stops no busy run', async ({
  onTestFinished,
}) => {
  const stopRun = vi.fn<() => void>()
  const busyId = parseConversationId(7)
  await registry.setLoaders({
    '/extensions/agent/web.solid.tsx': async () => ({
      default: {
        commands: [
          {
            id: 'agent.stop',
            title: 'Stop the run',
            keys: 'escape',
            whileTyping: true,
            when: (context: UltimateContext) => context.conversationId === busyId,
            run: stopRun,
          },
        ],
      },
    }),
  })
  const uninstall = installShortcuts()
  onTestFinished(async () => {
    uninstall()
    await registry.setLoaders({})
  })
  let open = true
  const [shown, setOpen] = createSignal(true)
  const page = renderSolid(() => (
    <div data-composer-target="conversation" data-conversation-scope={busyId}>
      <Popover
        open={shown()}
        onOpenChange={(next) => {
          open = next
          setOpen(next)
        }}
      >
        <PopoverTrigger>Settings</PopoverTrigger>
        <PopoverContent>
          <input aria-label="Popover field" />
        </PopoverContent>
      </Popover>
    </div>
  ))
  await settle()
  const field = page.ownerDocument.querySelector<HTMLInputElement>('[aria-label="Popover field"]')!
  field.focus()
  await settle()
  const { recorder } = mount({ name: 'box A', draft: 1 })
  await press('Record the screen into box A')
  field.focus()
  const escape = (type: 'keydown' | 'keyup', repeat = false) =>
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent(type, { key: 'Escape', cancelable: true, bubbles: true, repeat }),
    )
  escape('keydown')
  escape('keydown', true)
  escape('keydown', true)
  await settle()
  flush()
  expect(recorder.state().phase).toBe('idle')
  expect(open).toBe(true)
  expect(stopRun).not.toHaveBeenCalled()
  escape('keyup')
  escape('keydown')
  await settle()
  flush()
  expect(open).toBe(false)
  expect(stopRun).not.toHaveBeenCalled()
  escape('keyup')
  escape('keydown')
  await settle()
  expect(stopRun).toHaveBeenCalledOnce()
})

it('abandons a start when sharing ends during the mic prompt, or setup throws', async () => {
  const { container } = mount({ name: 'box A', draft: 1 })
  const micAsked = Promise.withResolvers<MediaStream>()
  microphone.mockReturnValueOnce(micAsked.promise)
  const starting = press('Record the screen into box A')
  await vi.waitFor(() => expect(microphone).toHaveBeenCalledOnce())
  screen.getVideoTracks()[0].end()
  micAsked.resolve(mic as unknown as MediaStream)
  await starting
  expect(FakeRecorder.last).toBeUndefined()
  expect(allStopped()).toBe(true)
  expect(released).not.toHaveBeenCalled()

  screen = new FakeStream([new FakeTrack('video')])
  mic = new FakeStream([new FakeTrack('audio')])
  FakeRecorder.failStart = true
  await press('Record the screen into box A')
  expect(allStopped()).toBe(true)
  expect(released).toHaveBeenCalledOnce()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('no encoder')
  expect(
    container.querySelector('[data-screen-recorder]')?.getAttribute('data-screen-recorder'),
  ).toBe('idle')
})

it('starts nothing when the person declines to share, and records the screen alone without a mic', async () => {
  const { container } = mount({ name: 'box A', draft: 1 })
  display.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
  await press('Record the screen into box A')
  expect(FakeRecorder.last).toBeUndefined()
  expect(container.querySelector('[role="alert"]')).toBeNull()

  microphone.mockRejectedValueOnce(new DOMException('no mic', 'NotFoundError'))
  await press('Record the screen into box A')
  expect(container.textContent).not.toContain('screen + mic')
  await press('Stop and attach the screen recording to box A')
  expect(attached).toHaveLength(1)
})

it('a Stop pressed in another box keeps that box’s draft when the box unmounts before the recorder stops', async () => {
  const [shown, setShown] = createRoot(() => createSignal(true))
  const { recorder } = mount({ name: 'box A', draft: 1 }, { name: 'box B', draft: 2, shown })
  await press('Record the screen into box A')
  FakeRecorder.async = true
  await press('Stop and attach the screen recording to box B')
  setShown(false)
  flush()
  FakeRecorder.later!()
  await settle()
  expect(attached).toEqual([])
  recorder.mount({
    draft: 2,
    attach: async (files) => (attached.push({ box: 'B again', draft: 2, files: [...files] }), true),
  })
  await settle()
  expect(attached.map((entry) => entry.box)).toEqual(['B again'])
})

it('a start that failed leaves no time limit behind to stop the next recording', async () => {
  vi.useFakeTimers()
  try {
    mount({ name: 'box A', draft: 1 })
    const record = () =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Record the screen into box A"]')!
        .click()
    FakeRecorder.failStart = true
    record()
    await vi.advanceTimersByTimeAsync(10)
    expect(released).toHaveBeenCalledOnce()
    FakeRecorder.failStart = false
    screen = new FakeStream([new FakeTrack('video')])
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    record()
    await vi.advanceTimersByTimeAsync(25 * 60_000)
    expect(FakeRecorder.last?.state).toBe('recording')
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    expect(attached).toHaveLength(1)
  } finally {
    vi.useRealTimers()
  }
})

it('offers a recording again to a box that remounted while its first box refused it', async () => {
  const { recorder } = mount({ name: 'box A', draft: 1 })
  await press('Record the screen into box A')
  const refused = Promise.withResolvers<boolean>()
  const unmountFirst = recorder.mount({ draft: 1, attach: () => refused.promise })
  await press('Stop and attach the screen recording to box A')
  attached.length = 0
  unmountFirst()
  recorder.mount({
    draft: 1,
    attach: async (files) => (
      attached.push({ box: 'remounted', draft: 1, files: [...files] }),
      true
    ),
  })
  refused.resolve(false)
  await settle()
  expect(attached.map((entry) => entry.box)).toEqual(['remounted'])
  expect(released).toHaveBeenCalledOnce()
})
