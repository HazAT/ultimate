import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.ts'
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
    const action = /\/actions\/([a-z]+)$/.exec(path)?.[1]
    const args = body.args as Record<string, unknown>
    if (action === 'begin') return Response.json({ result: { id: `v_${'a'.repeat(32)}` } })
    if (action === 'append')
      return Response.json({ result: { received: (args.offset as number) + 1 } })
    if (action === 'finish') {
      harness.finished?.()
      return Response.json({ result: { id: args.id, state: 'preparing' } })
    }
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
import type { Video } from '../../refs.ts'

const agent = createAgent()
const id = `v_${'a'.repeat(32)}`

beforeEach(async ({ onTestFinished }) => {
  harness.sources.length = 0
  harness.posts.length = 0
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
  drop(container, [video, pdf])
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

  videoState({ state: 'ready', seconds: 41.6 })
  await settle()
  flush()
  expect(chipNotes(container)).toEqual(['42 s · for Google', '4 B · PDF'])
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
