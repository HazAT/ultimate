import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { beforeEach, expect, it, vi } from 'vitest'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { recordButton } from '../../button.solid.tsx'
import { createScreenRecorder } from '../../capture.ts'

class FakeTrack extends EventTarget {
  stopped = false
  readonly kind: 'audio' | 'video'
  constructor(kind: 'audio' | 'video') {
    super()
    this.kind = kind
  }
  stop() {
    this.stopped = true
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
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob(['frames']) }))
    this.dispatchEvent(new Event('stop'))
  }
}
class FakeAudio {
  static closed = 0
  createMediaStreamDestination = () => ({ stream: new FakeStream([new FakeTrack('audio')]) })
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
const attached: { box: string; files: File[] }[] = []
const marks: boolean[] = []

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
  FakeAudio.closed = 0
  FakeRecorder.last = undefined
})

function mount(...names: string[]) {
  const recorder = createScreenRecorder({
    display,
    mic: microphone,
    hold: () => released,
    now: () => 0,
  })
  const Button = recordButton(recorder, () => true)
  const container = renderSolid(() =>
    names.map((name) => (
      <Button
        attach={(files) => attached.push({ box: name, files: [...files] })}
        name={name}
        recording={(on) => marks.push(on)}
      />
    )),
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

const allStopped = () => [...screen.tracks, ...mic.tracks].every((track) => track.stopped)

it('records screen and mic into one webm and attaches it to the box it was stopped from', async () => {
  const { container } = mount('box A', 'box B')
  await press('Record the screen into box A')
  expect(display).toHaveBeenCalledOnce()
  expect(FakeRecorder.last?.mimeType).toBe('video/webm;codecs=vp9,opus')
  expect(FakeRecorder.last?.stream.getVideoTracks()).toEqual(screen.getVideoTracks())
  expect(FakeRecorder.last?.stream.getAudioTracks()).toHaveLength(1)
  expect(container.textContent).toContain('screen + mic')
  expect(marks.at(-1)).toBe(true)
  await expectDistinctAgentNames(agent)

  await press('Stop and attach the screen recording to box B')
  expect(attached).toHaveLength(1)
  expect(attached[0].box).toBe('box B')
  expect(attached[0].files[0]).toMatchObject({ type: 'video/webm' })
  expect(attached[0].files[0].name).toMatch(/^Screen recording .+\.webm$/)
  expect(allStopped()).toBe(true)
  expect(FakeAudio.closed).toBe(1)
  expect(released).toHaveBeenCalledOnce()
  expect(marks.at(-1)).toBe(false)
})

it('keeps the recording when the browser’s Stop sharing ends it, for the box that started it', async () => {
  mount('box A', 'box B')
  await press('Record the screen into box B')
  screen.getVideoTracks()[0].dispatchEvent(new Event('ended'))
  flush()
  expect(attached.map((entry) => entry.box)).toEqual(['box B'])
  expect(allStopped()).toBe(true)
})

it('discards on Cancel and on Escape: nothing attaches and every track is released', async () => {
  mount('box A')
  await press('Record the screen into box A')
  await press('Cancel the screen recording in box A')
  expect(attached).toEqual([])
  expect(allStopped()).toBe(true)
  expect(released).toHaveBeenCalledOnce()

  screen = new FakeStream([new FakeTrack('video')])
  mic = new FakeStream([new FakeTrack('audio')])
  await press('Record the screen into box A')
  const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
  window.dispatchEvent(escape)
  flush()
  expect(escape.defaultPrevented).toBe(true)
  expect(attached).toEqual([])
  expect(allStopped()).toBe(true)
  expect(released).toHaveBeenCalledTimes(2)
})

it('starts nothing when the person declines to share, and records the screen alone without a mic', async () => {
  const { container } = mount('box A')
  display.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
  await press('Record the screen into box A')
  expect(FakeRecorder.last).toBeUndefined()
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(released).not.toHaveBeenCalled()

  microphone.mockRejectedValueOnce(new DOMException('no mic', 'NotFoundError'))
  await press('Record the screen into box A')
  expect(container.textContent).toContain('screen')
  expect(container.textContent).not.toContain('screen + mic')
  await press('Stop and attach the screen recording to box A')
  expect(attached).toHaveLength(1)
})
