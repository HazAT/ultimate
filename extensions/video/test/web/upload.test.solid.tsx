import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { createRoot, createSignal, flush, Show } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.shared.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  posts: [] as {
    path: string
    body: { args?: Record<string, unknown> } & Record<string, unknown>
  }[],
  finished: undefined as (() => void) | undefined,
  hold: undefined as
    | ((action: string, args: Record<string, unknown>) => Promise<void> | undefined)
    | undefined,
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const subscriptions = (harness.server = fakeSubscriptions(harness.sources))
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    const answered = subscriptions.handle(path, init)
    if (answered) return answered
    if (path === '/api/models')
      return Response.json({
        providers: [],
        models: [{ provider: 'faux', id: 'faux-1', available: true }],
      })
    const body = init?.body ? JSON.parse(init.body as string) : {}
    harness.posts.push({ path, body })
    const action =
      /\/actions\/([a-z]+)$/.exec(path)?.[1] ?? (path.endsWith('/submit') ? 'submit' : undefined)
    const args = body.args as Record<string, unknown>
    if (action) await harness.hold?.(action, args)
    if (action === 'begin') return Response.json({ result: { id: `v_${'a'.repeat(32)}` } })
    if (action === 'append')
      return Response.json({ result: { received: (args.offset as number) + 1 } })
    if (action === 'finish') {
      harness.finished?.()
      return Response.json({ result: { id: args.id, state: 'preparing' } })
    }
    if (action === 'remove') return Response.json({ result: null })
    if (action === 'thumbnail') return Response.json({ result: 'data:image/jpeg;base64,AAAA' })
    if (action === 'upload')
      return Response.json({ result: { path: `/home/attachments/${'1'.repeat(13)}-x/notes.pdf` } })
    return Response.json({ ok: true, submissionId: 1 })
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
  return {
    store,
    api,
    reads: createReads(api, store),
    registry: createRegistry(),
    uiState: createUiState(undefined),
  }
})

import { getDraft } from '../../../../web/src/app/drafts.ts'
import { Composer } from '../../../../web/src/app/composer.solid.tsx'
import { registry, store } from '../../../../web/src/sdk/client.ts'
import { VideosDoc } from '../../refs.ts'
import type { AskDetails, Video } from '../../refs.ts'
import { VideoAskCall } from '../../call.solid.tsx'
import type { ToolCallView } from '../../../../web/src/sdk/solid.ts'
import { PromptRecorder, provide, UserText } from '../../../../web/src/sdk/solid.ts'
import { Button } from '../../../../web/src/components/ui/button.solid.tsx'

const agent = createAgent()
const id = `v_${'a'.repeat(32)}`

const held = (action: string, offset?: number) => {
  const { promise: reached, resolve: reach } = Promise.withResolvers<void>()
  const { promise: release, resolve } = Promise.withResolvers<void>()
  harness.hold = (name, args) => {
    if (name !== action || (offset !== undefined && args.offset !== offset)) return undefined
    reach()
    return release
  }
  return { reached, release: resolve }
}
const videoActions = () =>
  harness.posts
    .filter((post) => post.path.startsWith('/api/extensions/video/'))
    .map((post) => post.path.replace('/api/extensions/video/actions/', ''))

beforeEach(async ({ onTestFinished }) => {
  harness.sources.length = 0
  harness.posts.length = 0
  harness.hold = undefined
  localStorage.clear()
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  store.start()
  onTestFinished(() => store.stop())
  harness.sources[0].open()
  await registry.setLoaders({
    '/extensions/attachments/web.solid.tsx': () => import('../../../attachments/web.solid.tsx'),
    '/extensions/video/web.solid.tsx': () => import('../../web.solid.tsx'),
  })
  onTestFinished(() => registry.setLoaders({}))
})
afterEach(() => vi.unstubAllGlobals())

async function show(conversation: number) {
  store.show(parseConversationId(conversation))
  await settle()
  harness.server!.of(conversation)!.send('view', {
    conversation: { id: parseConversationId(conversation) },
    entries: [],
    docs: { 'pi.agent': { model: { provider: 'faux', modelId: 'faux-1' } } },
  })
  await store.refreshModels()
  flush()
}

function drop(container: HTMLElement, files: File[]) {
  const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files } })
  container.querySelector('[data-ui="prompt-box"]')!.dispatchEvent(event)
}

const videoState = (video: Partial<Video>) =>
  harness.server!.of(1)!.send('doc', {
    kind: VideosDoc.kind,
    value: {
      videos: {
        [id]: {
          id,
          name: 'demo.webm',
          mimeType: 'video/webm',
          bytes: 9 * 1024 * 1024,
          source: 'drop',
          conversation: 21,
          state: 'preparing',
          createdAt: 0,
          ...video,
        },
      },
      threads: {},
    },
  })

const chipNotes = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-ui="file-chip"]')].map(
    (chip) => chip.querySelectorAll('p')[1]?.textContent,
  )

it('routes a dropped video to video in 8 MB chunks and other files to attachments, then sends the video line', async () => {
  await show(21)
  const container = renderSolid(() => <Composer />)
  await settle()
  flush()
  const finished = new Promise<void>((resolve) => {
    harness.finished = resolve
  })
  const video = new File([new Uint8Array(9 * 1024 * 1024)], 'demo.webm', { type: 'video/webm' })
  const pdf = new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' })
  const second = held('append', 8 * 1024 * 1024)
  drop(container, [video, pdf])
  await second.reached
  await settle()
  flush()
  expect(chipNotes(container)).toEqual(['Uploading 88%', '4 B · PDF'])
  expect(
    container.querySelector<HTMLElement>('[data-ui="file-chip"] span span')?.style.transform,
  ).toBe('scaleX(0.888889)')
  second.release()
  await finished
  await settle()
  flush()

  const calls = harness.posts
    .filter((post) => post.path.startsWith('/api/extensions/'))
    .map(({ path, body }) => {
      const { data, ...args } = body.args ?? {}
      return [
        path.replace('/api/extensions/', ''),
        { ...args, ...(typeof data === 'string' && { data: data.length }) },
        body.conversationId,
      ]
    })
  expect(calls).toEqual(
    expect.arrayContaining([
      [
        'video/actions/begin',
        { name: 'demo.webm', mimeType: 'video/webm', bytes: 9 * 1024 * 1024, source: 'drop' },
        21,
      ],
      ['video/actions/append', { id, offset: 0, data: Math.ceil((8 * 1024 * 1024) / 3) * 4 }, 21],
      [
        'video/actions/append',
        { id, offset: 8 * 1024 * 1024, data: Math.ceil((1024 * 1024) / 3) * 4 },
        21,
      ],
      ['video/actions/finish', { id }, 21],
      ['attachments/actions/upload', { name: 'notes.pdf', data: 8 }, 21],
    ]),
  )
  expect(calls.filter(([path]) => String(path).startsWith('video/')).map(([path]) => path)).toEqual(
    ['video/actions/begin', 'video/actions/append', 'video/actions/append', 'video/actions/finish'],
  )
  expect(chipNotes(container)).toEqual(['Preparing · for Google', '4 B · PDF'])
  expect(container.querySelector('[data-ui="file-chip-image"]')).toBeNull()

  videoState({ state: 'ready', seconds: 41.6, thumbnail: 'parts/thumbnail.jpg' })
  await settle()
  flush()
  expect(chipNotes(container)).toEqual(['42 s · for Google', '4 B · PDF'])
  expect(
    container.querySelector<HTMLImageElement>('[data-ui="file-chip-image"]')?.getAttribute('src'),
  ).toBe('data:image/jpeg;base64,AAAA')
  await expectDistinctAgentNames(agent)

  const result = await agent.act({
    steps: [
      { ref: 'Prompt for conversation #21', action: 'setValue', args: ['what happens?'] },
      { ref: 'Send prompt to conversation #21', action: 'press' },
    ],
  })
  await settle()
  expect(result.ok).toBe(true)
  const submitted = harness.posts.find((post) => post.path.endsWith('/submit'))!.body
  expect(submitted.text).toBe(
    [
      'what happens?',
      '',
      `Attached video: \`demo.webm\` (42 s), id \`${id}\`; ask about it with video_ask`,
      `Attached file: \`notes.pdf\` (4 B, application/pdf) at \`/home/attachments/${'1'.repeat(13)}-x/notes.pdf\``,
    ].join('\n'),
  )
  expect(getDraft(21).get().files).toEqual([])
})

it('drops the chip and shows the reason when preparation fails', async () => {
  await show(22)
  const container = renderSolid(() => <Composer />)
  await settle()
  flush()
  const finished = new Promise<void>((resolve) => {
    harness.finished = resolve
  })
  drop(container, [new File(['x'], 'broken.mp4', { type: 'video/mp4' })])
  await finished
  await settle()
  flush()
  expect(chipNotes(container)).toEqual(['Preparing · for Google'])
  videoState({ name: 'broken.mp4', state: 'failed', error: 'ffprobe found no video stream' })
  await settle()
  flush()
  expect(chipNotes(container)).toEqual([])
  expect(getDraft(22).get().error).toBe('broken.mp4: ffprobe found no video stream')
})

it('removes the video when the chip goes while begin is pending or after an append fails', async () => {
  await show(23)
  const container = renderSolid(() => <Composer />)
  await settle()
  flush()
  const begin = held('begin')
  drop(container, [new File(['x'], 'early.mp4', { type: 'video/mp4' })])
  await begin.reached
  await agent.act({ steps: [{ ref: 'Remove file 1: early.mp4', action: 'press' }] })
  begin.release()
  await settle()
  flush()
  expect(videoActions()).toEqual(['begin', 'remove'])
  expect(chipNotes(container)).toEqual([])
  expect(getDraft(23).get().error).toBeUndefined()

  harness.posts.length = 0
  harness.hold = (name) => (name === 'append' ? Promise.reject(new Error('disk full')) : undefined)
  drop(container, [new File(['x'], 'later.mp4', { type: 'video/mp4' })])
  await settle()
  flush()
  expect(videoActions()).toEqual(['begin', 'append', 'remove'])
  expect(chipNotes(container)).toEqual([])
  expect(getDraft(23).get().error).toContain('later.mp4:')
})

it('shows a video_ask call going from asking Gemini to its answer and usage', async () => {
  const call = (status: ToolCallView['status'], details: AskDetails): ToolCallView => ({
    id: 'ask-1',
    name: 'video_ask',
    args: { id, question: 'What is written?' },
    status,
    output: '',
    images: [],
    diagnostics: [],
    details,
  })
  const [view, setView] = createRoot(() =>
    createSignal(
      call('running', { stage: 'asking', part: 2, parts: 3, name: 'demo.webm', seconds: 41.6 }),
    ),
  )
  const container = renderSolid(() => (
    <VideoAskCall call={view()} core={<p data-testid="core">{view().output}</p>} />
  ))
  await settle()
  flush()
  expect(container.textContent).toContain('demo.webm · 42 s')
  expect(container.querySelector('.animate-shimmer')?.textContent).toBe(
    'asking Gemini · part 2 of 3',
  )
  setView(
    call('done', {
      stage: 'answered',
      name: 'demo.webm',
      seconds: 41.6,
      answer: 'It says PELICAN.',
      model: 'google/gemini-4-neon',
      usage: { promptTokenCount: 4200, candidatesTokenCount: 12, totalTokenCount: 4212 },
    }),
  )
  flush()
  expect(container.querySelector('.animate-shimmer')).toBeNull()
  expect(container.querySelector('[data-video-thumbnail]')).toBeNull()
  videoState({ state: 'ready', seconds: 41.6, thumbnail: 'parts/thumbnail.jpg' })
  await settle()
  flush()
  expect(container.querySelector('[data-video-thumbnail]')?.getAttribute('src')).toBe(
    'data:image/jpeg;base64,AAAA',
  )
  expect(container.textContent).toContain('It says PELICAN.')
  expect(container.textContent).toContain(
    'google/gemini-4-neon · 4.2k in · 12 out · sent to Google (Gemini API)',
  )
  await expectDistinctAgentNames(agent)

  setView({ ...call('done', { usage: {} } as unknown as AskDetails), output: 'Earlier answer' })
  flush()
  expect(container.querySelector('[data-testid="core"]')?.textContent).toBe('Earlier answer')
  setView({
    ...call('error', { stage: 'asking', part: 1, parts: 1, name: 'demo.webm' }),
    output: 'Unknown video',
  })
  flush()
  expect(container.querySelector('[data-testid="core"]')?.textContent).toBe('Unknown video')
})

it('a sent message shows its video as a chip with the first frame, name and length, never the raw line', async () => {
  await show(24)
  const text = [
    'what happens here?',
    '',
    `Attached video: \`demo.webm\` (42 s), id \`${id}\`; ask about it with video_ask`,
  ].join('\n')
  const container = renderSolid(() => <UserText text={text} />)
  await settle()
  videoState({ state: 'ready', seconds: 41.6, thumbnail: 'parts/thumbnail.jpg' })
  await settle()
  flush()
  expect(container.textContent).not.toContain('Attached video')
  expect(container.querySelector('p')?.textContent).toBe('what happens here?')
  expect(chipNotes(container)).toEqual(['42 s · WEBM'])
  expect(container.querySelector('[data-ui="file-chip"] p')?.textContent).toBe('demo.webm')
  expect(
    container.querySelector<HTMLImageElement>('[data-ui="file-chip-image"]')?.getAttribute('src'),
  ).toBe('data:image/jpeg;base64,AAAA')
})

it('a recording stopped while a typed prompt is sending waits for it, so the sent prompt still clears', async () => {
  const recording = new File(['frames'], 'Screen recording.webm', { type: 'video/webm' })
  let attached: Promise<boolean> | undefined
  function Recorder(props: { attach: (files: readonly File[]) => Promise<boolean> }) {
    return (
      <Button
        onClick={() => {
          attached = props.attach([recording])
        }}
      >
        Stop the test recording
      </Button>
    )
  }
  await registry.setLoaders({
    '/extensions/attachments/web.solid.tsx': () => import('../../../attachments/web.solid.tsx'),
    '/extensions/video/web.solid.tsx': () => import('../../web.solid.tsx'),
    '/extensions/recorder/web.solid.tsx': async () => ({
      default: { provides: [provide(PromptRecorder, Recorder)] },
    }),
  })
  await show(24)
  const container = renderSolid(() => <Composer />)
  await settle()
  flush()
  const submit = held('submit')
  await agent.act({
    steps: [{ ref: 'Prompt for conversation #24', action: 'setValue', args: ['look at this'] }],
  })
  container
    .querySelector<HTMLButtonElement>('button[aria-label="Send prompt to conversation #24"]')!
    .click()
  await submit.reached
  container
    .querySelector<HTMLButtonElement>('[data-ui="prompt-box"] button:not([aria-label])')!
    .click()
  await settle()
  expect(videoActions()).toEqual([])
  submit.release()
  await settle()
  flush()
  expect(getDraft(24).get().text).toBe('')
  expect(videoActions()[0]).toBe('begin')
  expect(harness.posts.find((post) => post.path.endsWith('/begin'))!.body.args).toMatchObject({
    source: 'recording',
  })
  videoState({ state: 'ready', seconds: 3 })
  expect(await attached!).toBe(true)
  expect(getDraft(24).get().files).toHaveLength(1)
})

it('a recording whose box unmounts during the send it waits for is refused, not uploaded', async () => {
  const recording = new File(['frames'], 'Screen recording.webm', { type: 'video/webm' })
  let attached: Promise<boolean> | undefined
  function Recorder(props: { attach: (files: readonly File[]) => Promise<boolean> }) {
    return (
      <Button
        onClick={() => {
          attached = props.attach([recording])
        }}
      >
        Stop the test recording
      </Button>
    )
  }
  await registry.setLoaders({
    '/extensions/attachments/web.solid.tsx': () => import('../../../attachments/web.solid.tsx'),
    '/extensions/video/web.solid.tsx': () => import('../../web.solid.tsx'),
    '/extensions/recorder/web.solid.tsx': async () => ({
      default: { provides: [provide(PromptRecorder, Recorder)] },
    }),
  })
  await show(25)
  const [shown, setShown] = createRoot(() => createSignal(true))
  const container = renderSolid(() => (
    <Show when={shown()}>
      <Composer />
    </Show>
  ))
  await settle()
  flush()
  const submit = held('submit')
  await agent.act({
    steps: [{ ref: 'Prompt for conversation #25', action: 'setValue', args: ['look'] }],
  })
  container
    .querySelector<HTMLButtonElement>('button[aria-label="Send prompt to conversation #25"]')!
    .click()
  await submit.reached
  container
    .querySelector<HTMLButtonElement>('[data-ui="prompt-box"] button:not([aria-label])')!
    .click()
  setShown(false)
  flush()
  submit.release()
  expect(await attached!).toBe(false)
  expect(videoActions()).toEqual([])
})
