import { settle } from '@ui-sdk/core/testing'
import { flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.shared.ts'
import { serverEndedSession } from './session.ts'
import { FakeSource } from '../../../../test/web/fake-source.ts'
import { composerDraft, getDraft } from '../../../../web/src/app/drafts.ts'
import { store as clientStore } from '../../../../web/src/sdk/client.ts'
import {
  coldDraft,
  composeIn,
  coldHolds,
  dispatch,
  dock,
  sendTyped,
  setSideChatSource,
  settleTranscripts,
  sideChatSink,
} from '../../dock.solid.tsx'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as
    | ReturnType<typeof import('../../../../test/web/fake-source.ts').fakeSubscriptions>
    | undefined,
  turns: [] as Record<string, unknown>[],
  route: 'audio',
  status: undefined as Promise<void> | undefined,
  asked: 0,
  stop: undefined as Promise<void> | undefined,
  stops: 0,
  destinations: [] as [string, number | undefined][],
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { answerReadsWith, fakeSubscriptions } = await import('../../../../test/web/fake-source.ts')
  const subscriptions = (harness.server = fakeSubscriptions(harness.sources))
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    const action = /^\/api\/extensions\/side-chat\/actions\/(status|record|turn)$/.exec(path)?.[1]
    if (action) harness.destinations.push([action, JSON.parse(init?.body as string).args.source])
    if (path === '/api/extensions/side-chat/actions/status') {
      harness.asked++
      await harness.status
      init?.signal?.throwIfAborted()
      return Response.json({
        result: { model: 'faux/voice', thinking: 'low', route: harness.route, forkable: true },
      })
    }
    if (path === '/api/extensions/side-chat/actions/turn') {
      harness.turns.push(JSON.parse(init?.body as string).args)
      return Response.json({ result: { conversation: 40, route: 'audio' } })
    }
    if (path === '/api/extensions/side-chat/actions/stop') {
      harness.stops++
      await harness.stop
      return Response.json({ result: {} })
    }
    if (path === '/api/extensions/side-chat/actions/record') {
      const { args } = JSON.parse(init?.body as string)
      return Response.json({ result: { audio: 'rec-1', session: args.session ?? 41 } })
    }
    return subscriptions.handle(path, init) ?? Response.json({ ok: true })
  }
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

const primary = parseConversationId(7)
const session = parseConversationId(40)
const cold = coldDraft(primary)
const shot = { data: 'cG5n', mimeType: 'image/png' }
const speak = () =>
  sideChatSink.finish(
    { blob: new Blob(['a'], { type: 'audio/webm' }), seconds: 2, spoke: true, envelope: [] },
    false,
  )

beforeEach(async ({ onTestFinished }) => {
  harness.sources.length = 0
  harness.turns.length = 0
  harness.route = 'audio'
  harness.status = undefined
  harness.asked = 0
  harness.stop = undefined
  harness.stops = 0
  harness.destinations.length = 0
  setSideChatSource(undefined)
  vi.stubGlobal('speechSynthesis', { cancel: () => undefined, speak: () => undefined })
  dock.setCuesOn(false)
  clientStore.start()
  onTestFinished(() => clientStore.stop())
  harness.sources[0].open()
  await settle()
  harness
    .server!.of(1)!
    .send('doc', { kind: 'ultimate.standing-agents', value: { ultimate: primary } })
  flush()
  await serverEndedSession(composeIn)
  composeIn(session)
  settleTranscripts({ of: primary }, session)
  getDraft(session).set({ images: [shot] })
})
afterEach(() => {
  vi.unstubAllGlobals()
  getDraft(session).set({ text: '', images: [], sending: false })
  getDraft(cold).set({ text: '', images: [], files: [], sending: false })
})

it('switching to an open fork cancels the first take and leaves the cold draft with its source', async () => {
  composeIn(undefined)
  harness.route = 'text'
  const draftA = getDraft(cold)
  draftA.set({ text: 'look at this', images: [shot] })
  const sent = speak()
  await settle()
  expect(harness.destinations).toEqual([
    ['status', primary],
    ['record', primary],
  ])
  expect(Object.values(dock.local())).toMatchObject([{ audio: 'rec-1' }])
  expect(draftA.get().sending).toBe(true)
  const second = parseConversationId(43)
  setSideChatSource(second)
  composeIn(session)
  await settle()
  expect(draftA.get().sending).toBe(false)
  await sent
  expect(harness.turns).toEqual([])

  harness.route = 'audio'
  getDraft(session).set({ text: 'B context', images: [] })
  await speak()
  expect(harness.turns).toEqual([
    expect.objectContaining({ source: second, session, text: 'B context', images: [] }),
  ])

  setSideChatSource(primary)
  expect(getDraft(coldDraft(primary)).get()).toMatchObject({
    text: 'look at this',
    images: [shot],
    sending: false,
  })
})

it('a spoken turn takes the images pasted into the side chat box and clears them', async () => {
  await speak()
  await settle()
  expect(harness.turns).toEqual([expect.objectContaining({ audio: 'rec-1', images: [shot] })])
  expect(getDraft(session).get().images).toEqual([])
})

it('what was typed and pasted while cold goes with the first turn, even when the recording opened the fork', async () => {
  await serverEndedSession(composeIn)
  getDraft(cold).set({ text: 'look at this', images: [shot] })
  composeIn(session)
  await speak()
  await settle()
  expect(harness.turns).toEqual([
    expect.objectContaining({ text: 'look at this', audio: 'rec-1', images: [shot] }),
  ])
  expect(getDraft(cold).get()).toMatchObject({ text: '', images: [] })
  expect(coldHolds(composerDraft(cold))).toBe(false)
})

it('a session that ends during a send stops it before it reaches that session', async () => {
  let answer = () => {}
  harness.status = new Promise((resolve) => (answer = resolve))
  const sending = speak()
  await vi.waitFor(() => expect(harness.asked).toBe(1))
  await serverEndedSession(composeIn)
  answer()
  await sending
  expect(harness.turns).toEqual([])
  expect(dock.local()).toEqual({})
})

it('a session that ends during a send from the composer rejects, so the composer keeps what was typed', async () => {
  let answer = () => {}
  harness.status = new Promise((resolve) => (answer = resolve))
  const sending = sendTyped('typed before it ended')
  await vi.waitFor(() => expect(harness.asked).toBe(1))
  await serverEndedSession(composeIn)
  answer()
  await expect(sending).rejects.toThrow('The side chat ended')
  expect(harness.turns).toEqual([])
})

it('what is typed into the cold box during the first send stays in the box the session shows', async () => {
  await serverEndedSession(composeIn)
  getDraft(cold).set({ text: 'first', revision: 1 })
  composeIn(session)
  let answer = () => {}
  harness.status = new Promise((resolve) => (answer = resolve))
  const sending = speak()
  await vi.waitFor(() => expect(harness.asked).toBe(1))
  getDraft(cold).set({ text: 'first and more', revision: 2 })
  answer()
  await sending
  expect(harness.turns).toEqual([expect.objectContaining({ text: 'first' })])
  expect(getDraft(cold).get().text).toBe('first and more')
  expect(coldHolds(composerDraft(cold))).toBe(true)
})

it('a turn after a recording that opened the session belongs to that session', async () => {
  await serverEndedSession(composeIn)
  const recorded = {
    blob: new Blob(['a'], { type: 'audio/webm' }),
    seconds: 1,
    spoke: true,
    envelope: [],
  }
  await sideChatSink.finish(recorded, false)
  await settle()
  expect(harness.turns).toEqual([expect.objectContaining({ session: 41 })])
})

it('a send from the cold box after the session opened carries its text once', async () => {
  await serverEndedSession(composeIn)
  getDraft(cold).set({ text: 'look at this' })
  composeIn(session)
  settleTranscripts({ of: primary }, session)
  await sendTyped('look at this', [])
  await settle()
  expect(harness.turns).toEqual([expect.objectContaining({ text: 'look at this' })])
})

it('a spoken cut-in while Enter is sending the box leaves the box to that send', async () => {
  getDraft(session).set({ images: [shot], sending: true })
  await speak()
  await settle()
  expect(harness.turns).toEqual([expect.objectContaining({ audio: 'rec-1', images: [] })])
  expect(getDraft(session).get().images).toEqual([shot])
  getDraft(session).set({ sending: false })
})

it('a spoken turn that ends without sending leaves the cold text and screenshot in the box', async () => {
  await serverEndedSession(composeIn)
  getDraft(cold).set({ text: 'look', images: [shot] })
  let answer = () => {}
  harness.status = new Promise((resolve) => (answer = resolve))
  const spoken = speak()
  await vi.waitFor(() => expect(harness.asked).toBe(1))
  expect(getDraft(cold).get()).toMatchObject({ text: 'look', images: [shot], sending: true })
  await serverEndedSession(composeIn)
  answer()
  await spoken
  expect(getDraft(cold).get()).toMatchObject({ text: 'look', images: [shot], sending: false })
})

it('a file attached to the cold box keeps it in view when the session opens', async () => {
  await serverEndedSession(composeIn)
  getDraft(cold).set({
    files: [{ id: 'f', name: 'spec.pdf', size: '1 KB', mimeType: 'application/pdf', path: '' }],
  })
  composeIn(session)
  expect(coldHolds(composerDraft(cold))).toBe(true)
})

it('a file upload finishing during a spoken turn still clears the text that turn sent', async () => {
  await serverEndedSession(composeIn)
  const pending = { id: 'f', name: 'spec.pdf', size: '1 KB', mimeType: 'application/pdf', path: '' }
  getDraft(cold).set({ text: 'look', files: [pending], revision: 1 })
  let answer = () => {}
  harness.status = new Promise((resolve) => (answer = resolve))
  const spoken = speak()
  await vi.waitFor(() => expect(harness.asked).toBe(1))
  getDraft(cold).set({ files: [{ ...pending, path: '/uploads/spec.pdf' }], revision: 2 })
  answer()
  await spoken
  expect(harness.turns).toEqual([expect.objectContaining({ text: 'look' })])
  expect(getDraft(cold).get()).toMatchObject({
    text: '',
    files: [expect.objectContaining({ path: '/uploads/spec.pdf' })],
  })
})

it('a spoken turn carries a finished video from the live box and clears its chip', async () => {
  const line =
    'Attached video: `Screen recording.webm` (12 s), id `v_ab12`; ask about it with video_ask'
  const video = { id: 'v', name: 'Screen recording.webm', size: '1 MB', mimeType: 'video/webm' }
  getDraft(session).set({ files: [{ ...video, path: '', line }], images: [] })
  await speak()
  expect(harness.turns).toEqual([expect.objectContaining({ text: line })])
  expect(getDraft(session).get()).toMatchObject({ files: [], sending: false })
})

it('stopping a recording sends what was typed and pasted into the live box with it, as one turn, and clears the box', async () => {
  getDraft(session).set({ text: 'more context', images: [shot] })
  const recorded = { blob: new Blob(['a'], { type: 'audio/webm' }), seconds: 2, spoke: true }
  await sideChatSink.finish({ ...recorded, envelope: [] }, false)
  await settle()
  expect(harness.turns).toEqual([
    expect.objectContaining({ text: 'more context', audio: 'rec-1', images: [shot] }),
  ])
  expect(getDraft(session).get()).toMatchObject({ text: '', images: [], sending: false })
})

it('a recording that heard nothing still sends what was typed and pasted into the box', async () => {
  getDraft(session).set({ text: 'more context', images: [shot] })
  const recorded = { blob: new Blob(['a'], { type: 'audio/webm' }), seconds: 2, spoke: false }
  await sideChatSink.finish({ ...recorded, envelope: [] }, false)
  await settle()
  expect(harness.turns).toEqual([expect.objectContaining({ text: 'more context', images: [shot] })])
  expect(harness.turns[0]).not.toHaveProperty('audio')
  expect(getDraft(session).get()).toMatchObject({ text: '', images: [], sending: false })
})

it('a silent stop whose box holds nothing it can send stops no reply and sends nothing', async () => {
  const pending = { id: 'f', name: 'spec.pdf', size: '1 KB', mimeType: 'application/pdf', path: '' }
  getDraft(session).set({ text: '', images: [], files: [pending] })
  dispatch({ type: 'send', key: 'earlier', voice: false })
  dispatch({ type: 'sent', key: 'earlier' })
  flush()
  const recorded = { blob: new Blob(['a'], { type: 'audio/webm' }), seconds: 2, spoke: false }
  dispatch({ type: 'press', busy: true })
  await sideChatSink.finish({ ...recorded, envelope: [] }, false)
  getDraft(session).set({ images: [shot], sending: true })
  dispatch({ type: 'press', busy: true })
  await sideChatSink.finish({ ...recorded, envelope: [] }, false)
  await settle()
  expect(harness.stops).toBe(0)
  expect(harness.turns).toEqual([])
  expect(getDraft(session).get().files).toEqual([pending])
  getDraft(session).set({ files: [], sending: false })
})
