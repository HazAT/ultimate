import { settle } from '@ui-sdk/core/testing'
import { flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.shared.ts'
import { serverEndedSession } from './session.ts'
import { FakeSource } from '../../../../test/web/fake-source.ts'
import { composerDraft, getDraft } from '../../../../web/src/app/drafts.ts'
import { store as clientStore } from '../../../../web/src/sdk/client.ts'
import {
  COLD_DRAFT,
  composeIn,
  coldHolds,
  dock,
  draftOf,
  sendDraft,
  sendTyped,
  settleTranscripts,
  voiceSink,
} from '../../dock.solid.tsx'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  turns: [] as Record<string, unknown>[],
  route: 'audio',
  status: undefined as Promise<void> | undefined,
  asked: 0,
  stop: undefined as Promise<void> | undefined,
  stops: 0,
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { answerReadsWith, fakeSubscriptions } = await import('../../../../test/web/fake-source.ts')
  const subscriptions = fakeSubscriptions(harness.sources)
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    if (path === '/api/extensions/voice-live/actions/status') {
      harness.asked++
      await harness.status
      init?.signal?.throwIfAborted()
      return Response.json({
        result: { model: 'faux/voice', thinking: 'low', route: harness.route },
      })
    }
    if (path === '/api/extensions/voice-live/actions/turn') {
      harness.turns.push(JSON.parse(init?.body as string).args)
      return Response.json({ result: { conversation: 40, route: 'audio' } })
    }
    if (path === '/api/extensions/voice-live/actions/stop') {
      harness.stops++
      await harness.stop
      return Response.json({ result: {} })
    }
    if (path === '/api/extensions/voice-live/actions/record')
      return Response.json({ result: { audio: 'rec-1', session: 41 } })
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

const session = parseConversationId(40)
const shot = { data: 'cG5n', mimeType: 'image/png' }
const clip = { audio: 'clip-1', seconds: 2 }

beforeEach(async ({ onTestFinished }) => {
  harness.sources.length = 0
  harness.turns.length = 0
  harness.route = 'audio'
  harness.status = undefined
  harness.asked = 0
  harness.stop = undefined
  harness.stops = 0
  vi.stubGlobal('speechSynthesis', { cancel: () => undefined, speak: () => undefined })
  dock.setCuesOn(false)
  clientStore.start()
  onTestFinished(() => clientStore.stop())
  harness.sources[0].open()
  await serverEndedSession(composeIn)
  composeIn(session)
  settleTranscripts({ of: parseConversationId(1), draft: [clip] }, session)
  getDraft(session).set({ images: [shot] })
})
afterEach(() => {
  vi.unstubAllGlobals()
  getDraft(session).set({ text: '', images: [], sending: false })
  getDraft(COLD_DRAFT).set({ text: '', images: [], files: [], sending: false })
})

it('a spoken "send it" takes the images pasted into the voice composer and clears them', async () => {
  await sendDraft('steer', '', true, [clip])
  await settle()
  expect(harness.turns).toEqual([expect.objectContaining({ clips: ['clip-1'], images: [shot] })])
  expect(getDraft(session).get().images).toEqual([])
})

it('the send button and Enter send the collected clips with the pasted images', async () => {
  await sendDraft('steer')
  await sendTyped('', [shot])
  await settle()
  expect(harness.turns).toEqual([
    expect.objectContaining({ clips: ['clip-1'], images: [shot] }),
    expect.objectContaining({ clips: ['clip-1'], images: [shot] }),
  ])
})

it('a spoken send leaves text typed into the live voice composer alone', async () => {
  getDraft(session).set({ text: 'half a thought' })
  await sendDraft('steer', '', true, [clip])
  await settle()
  expect(harness.turns).toEqual([expect.objectContaining({ text: '', images: [shot] })])
  expect(getDraft(session).get().text).toBe('half a thought')
})

it('what was typed and pasted while cold goes with the first turn, even when collecting opened the fork', async () => {
  await serverEndedSession(composeIn)
  getDraft(COLD_DRAFT).set({ text: 'look at this', images: [shot] })
  composeIn(session)
  await sendDraft('steer', '', true, [clip])
  await settle()
  expect(harness.turns).toEqual([
    expect.objectContaining({ text: 'look at this', clips: ['clip-1'], images: [shot] }),
  ])
  expect(getDraft(COLD_DRAFT).get()).toMatchObject({ text: '', images: [] })
  expect(coldHolds(composerDraft(COLD_DRAFT))).toBe(false)
})

it('a session that ends during a send stops it before it reaches that session', async () => {
  let answer = () => {}
  harness.status = new Promise((resolve) => (answer = resolve))
  const sending = sendDraft('steer')
  await vi.waitFor(() => expect(harness.asked).toBe(1))
  await serverEndedSession(composeIn)
  answer()
  await sending
  expect(harness.turns).toEqual([])
  expect(draftOf()).toEqual([])
  expect(dock.local()).toEqual({})
})

it('a session that ends drops the collected clips and a transcription that settles afterwards', async () => {
  harness.route = 'text'
  const sending = sendDraft('steer')
  await vi.waitFor(() => expect(harness.asked).toBe(1))
  await settle()
  await serverEndedSession(composeIn)
  await sending
  settleTranscripts({ transcripts: { 'clip-1': 'too late' }, draft: [clip] }, session)
  await settle()
  expect(harness.turns).toEqual([])
  expect(draftOf()).toEqual([])
  expect(dock.local()).toEqual({})
  expect(dock.phase()).toBe('idle')
})

it('a session that ends during a send from the composer rejects, so the composer keeps what was typed', async () => {
  let answer = () => {}
  harness.status = new Promise((resolve) => (answer = resolve))
  const sending = sendTyped('typed before it ended')
  await vi.waitFor(() => expect(harness.asked).toBe(1))
  await serverEndedSession(composeIn)
  answer()
  await expect(sending).rejects.toThrow('The voice session ended')
  expect(harness.turns).toEqual([])
})

it('what is typed into the cold box during the first send stays in the box the session shows', async () => {
  await serverEndedSession(composeIn)
  getDraft(COLD_DRAFT).set({ text: 'first', revision: 1 })
  composeIn(session)
  let answer = () => {}
  harness.status = new Promise((resolve) => (answer = resolve))
  const sending = sendDraft('steer', '', true, [clip])
  await vi.waitFor(() => expect(harness.asked).toBe(1))
  getDraft(COLD_DRAFT).set({ text: 'first and more', revision: 2 })
  answer()
  await sending
  expect(harness.turns).toEqual([expect.objectContaining({ text: 'first' })])
  expect(getDraft(COLD_DRAFT).get().text).toBe('first and more')
  expect(coldHolds(composerDraft(COLD_DRAFT))).toBe(true)
})

it('a turn after a recording that opened the session belongs to that session', async () => {
  await serverEndedSession(composeIn)
  dock.setCollect(false)
  const recorded = {
    blob: new Blob(['a'], { type: 'audio/webm' }),
    seconds: 1,
    spoke: true,
    envelope: [],
  }
  await voiceSink.finish(recorded, false)
  await settle()
  expect(harness.turns).toEqual([expect.objectContaining({ session: 41 })])
})

it('a send from the cold box after the session opened carries its text once', async () => {
  await serverEndedSession(composeIn)
  getDraft(COLD_DRAFT).set({ text: 'look at this' })
  composeIn(session)
  settleTranscripts({ of: parseConversationId(1) }, session)
  expect(draftOf()).toEqual([])
  await sendTyped('look at this', [])
  await settle()
  expect(harness.turns).toEqual([expect.objectContaining({ text: 'look at this' })])
})

it('the send button while a spoken turn holds the collected clip and the box sends nothing more', async () => {
  await serverEndedSession(composeIn)
  composeIn(session)
  settleTranscripts({ of: parseConversationId(1), draft: [clip] }, session)
  harness.route = 'text'
  getDraft(COLD_DRAFT).set({ text: 'look', images: [shot] })
  const spoken = sendDraft('steer', '', true, [clip])
  await vi.waitFor(() => expect(harness.asked).toBe(1))
  await settle()
  expect(getDraft(COLD_DRAFT).get()).toMatchObject({ text: 'look', images: [shot], sending: true })
  await sendDraft('steer')
  settleTranscripts({ of: parseConversationId(1), transcripts: { 'clip-1': 'hello' } }, session)
  await spoken
  await settle()
  expect(harness.turns).toEqual([
    expect.objectContaining({ text: 'hello\n\nlook', clips: ['clip-1'], images: [shot] }),
  ])
  expect(getDraft(COLD_DRAFT).get()).toMatchObject({ text: '', images: [], sending: false })
})

it('a spoken cut-in while Enter is sending the box leaves the box to that send', async () => {
  getDraft(session).set({ images: [shot], sending: true })
  await sendDraft('steer', '', true, [clip])
  await settle()
  expect(harness.turns).toEqual([expect.objectContaining({ clips: ['clip-1'], images: [] })])
  expect(getDraft(session).get().images).toEqual([shot])
  getDraft(session).set({ sending: false })
})

it('a spoken turn that ends without sending leaves the cold text and screenshot in the box', async () => {
  await serverEndedSession(composeIn)
  getDraft(COLD_DRAFT).set({ text: 'look', images: [shot] })
  let answer = () => {}
  harness.status = new Promise((resolve) => (answer = resolve))
  const spoken = sendDraft('steer', '', true, [clip])
  await vi.waitFor(() => expect(harness.asked).toBe(1))
  expect(getDraft(COLD_DRAFT).get()).toMatchObject({ text: 'look', images: [shot], sending: true })
  await serverEndedSession(composeIn)
  answer()
  await spoken
  expect(getDraft(COLD_DRAFT).get()).toMatchObject({ text: 'look', images: [shot], sending: false })
})

it('a cut-in holds the collected clip and the box from the start, so follow-up during its stop sends nothing', async () => {
  let stopped = () => {}
  harness.stop = new Promise((resolve) => (stopped = resolve))
  dock.setPhase('thinking')
  flush()
  const steer = sendDraft('steer', '', true, [clip])
  await vi.waitFor(() => expect(harness.stops).toBe(1))
  expect(getDraft(session).get().sending).toBe(true)
  await sendDraft('followUp')
  stopped()
  await steer
  await settle()
  expect(harness.turns).toEqual([expect.objectContaining({ clips: ['clip-1'], images: [shot] })])
  expect(harness.turns[0].delivery).toBeUndefined()
  expect(getDraft(session).get()).toMatchObject({ images: [], sending: false })
})

it('a file attached to the cold box keeps it in view when the session opens', async () => {
  await serverEndedSession(composeIn)
  getDraft(COLD_DRAFT).set({
    files: [{ id: 'f', name: 'spec.pdf', size: '1 KB', mimeType: 'application/pdf', path: '' }],
  })
  composeIn(session)
  expect(coldHolds(composerDraft(COLD_DRAFT))).toBe(true)
})

it('a file upload finishing during a spoken turn still clears the text that turn sent', async () => {
  await serverEndedSession(composeIn)
  const pending = { id: 'f', name: 'spec.pdf', size: '1 KB', mimeType: 'application/pdf', path: '' }
  getDraft(COLD_DRAFT).set({ text: 'look', files: [pending], revision: 1 })
  let answer = () => {}
  harness.status = new Promise((resolve) => (answer = resolve))
  const spoken = sendDraft('steer', '', true, [clip])
  await vi.waitFor(() => expect(harness.asked).toBe(1))
  getDraft(COLD_DRAFT).set({ files: [{ ...pending, path: '/uploads/spec.pdf' }], revision: 2 })
  answer()
  await spoken
  expect(harness.turns).toEqual([expect.objectContaining({ text: 'look' })])
  expect(getDraft(COLD_DRAFT).get()).toMatchObject({
    text: '',
    files: [expect.objectContaining({ path: '/uploads/spec.pdf' })],
  })
})

it('a spoken turn carries a finished video from the live box and clears its chip', async () => {
  const line =
    'Attached video: `Screen recording.webm` (12 s), id `v_ab12`; ask about it with video_ask'
  const video = { id: 'v', name: 'Screen recording.webm', size: '1 MB', mimeType: 'video/webm' }
  getDraft(session).set({ files: [{ ...video, path: '', line }], images: [] })
  await sendDraft('steer', '', true, [clip])
  expect(harness.turns).toEqual([expect.objectContaining({ text: line })])
  expect(getDraft(session).get()).toMatchObject({ files: [], sending: false })
})

it('a spoken turn that takes nothing from the live box leaves it open for typing', async () => {
  getDraft(session).set({ text: 'still typing', images: [] })
  harness.route = 'text'
  const spoken = sendDraft('steer', '', true, [clip])
  await vi.waitFor(() => expect(harness.asked).toBe(1))
  await settle()
  expect(getDraft(session).get().sending).toBe(false)
  settleTranscripts({ of: parseConversationId(1), transcripts: { 'clip-1': 'hello' } }, session)
  await spoken
  expect(getDraft(session).get()).toMatchObject({ text: 'still typing', sending: false })
})
