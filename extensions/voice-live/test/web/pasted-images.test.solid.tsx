import { settle } from '@ui-sdk/core/testing'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.ts'
import { FakeSource } from '../../../../test/web/fake-source.ts'
import { getDraft } from '../../../../web/src/app/drafts.ts'
import { store as clientStore } from '../../../../web/src/sdk/client.ts'
import {
  COLD_DRAFT,
  composeIn,
  composerOf,
  dock,
  draftOf,
  endSession,
  sendDraft,
  sendTyped,
  settleTranscripts,
} from '../../dock.solid.tsx'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  turns: [] as Record<string, unknown>[],
  route: 'audio',
  status: undefined as Promise<void> | undefined,
  asked: 0,
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
      return Response.json({ result: { model: 'faux/voice', route: harness.route } })
    }
    if (path === '/api/extensions/voice-live/actions/turn') {
      harness.turns.push(JSON.parse(init?.body as string).args)
      return Response.json({ result: { conversation: 40, route: 'audio' } })
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

const session = parseConversationId(40)
const shot = { data: 'cG5n', mimeType: 'image/png' }
const clip = { audio: 'clip-1', seconds: 2 }

beforeEach(async ({ onTestFinished }) => {
  harness.sources.length = 0
  harness.turns.length = 0
  harness.route = 'audio'
  harness.status = undefined
  harness.asked = 0
  vi.stubGlobal('speechSynthesis', { cancel: () => undefined, speak: () => undefined })
  dock.setCuesOn(false)
  clientStore.start()
  onTestFinished(() => clientStore.stop())
  harness.sources[0].open()
  await endSession()
  composeIn(session)
  settleTranscripts({ of: parseConversationId(1), draft: [clip] }, session)
  getDraft(session).set({ images: [shot] })
})
afterEach(() => {
  vi.unstubAllGlobals()
  getDraft(session).set({ text: '', images: [] })
  getDraft(COLD_DRAFT).set({ text: '', images: [] })
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
  await endSession()
  getDraft(COLD_DRAFT).set({ text: 'look at this', images: [shot] })
  composeIn(session)
  expect(composerOf(session)).toBe(COLD_DRAFT)
  await sendDraft('steer', '', true, [clip])
  await settle()
  expect(harness.turns).toEqual([
    expect.objectContaining({ text: 'look at this', clips: ['clip-1'], images: [shot] }),
  ])
  expect(getDraft(COLD_DRAFT).get()).toMatchObject({ text: '', images: [] })
  expect(composerOf(session)).toBe(session)
})

it('End during a send stops it before it reaches the session it ended', async () => {
  let answer = () => {}
  harness.status = new Promise((resolve) => (answer = resolve))
  const sending = sendDraft('steer')
  await vi.waitFor(() => expect(harness.asked).toBe(1))
  await endSession()
  answer()
  await sending
  expect(harness.turns).toEqual([])
  expect(draftOf()).toEqual([])
  expect(dock.local()).toEqual({})
})

it('End drops the collected clips and a transcription that settles afterwards', async () => {
  harness.route = 'text'
  const sending = sendDraft('steer')
  await vi.waitFor(() => expect(harness.asked).toBe(1))
  await settle()
  await endSession()
  await sending
  settleTranscripts({ transcripts: { 'clip-1': 'too late' }, draft: [clip] }, session)
  await settle()
  expect(harness.turns).toEqual([])
  expect(draftOf()).toEqual([])
  expect(dock.local()).toEqual({})
  expect(dock.phase()).toBe('idle')
})

it('End during a send from the composer rejects, so the composer keeps what was typed', async () => {
  let answer = () => {}
  harness.status = new Promise((resolve) => (answer = resolve))
  const sending = sendTyped('typed before End')
  await vi.waitFor(() => expect(harness.asked).toBe(1))
  await endSession()
  answer()
  await expect(sending).rejects.toThrow('The voice session ended')
  expect(harness.turns).toEqual([])
})

it('what is typed into the cold box during the first send stays in the box the session shows', async () => {
  await endSession()
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
  expect(composerOf(session)).toBe(COLD_DRAFT)
})
