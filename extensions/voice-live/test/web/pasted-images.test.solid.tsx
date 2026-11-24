import { settle } from '@ui-sdk/core/testing'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.ts'
import { FakeSource } from '../../../../test/web/fake-source.ts'
import { getDraft } from '../../../../web/src/app/drafts.ts'
import { store as clientStore } from '../../../../web/src/sdk/client.ts'
import { dock, sendDraft, sendTyped, settleTranscripts } from '../../dock.solid.tsx'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  turns: [] as Record<string, unknown>[],
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
    if (path === '/api/extensions/voice-live/actions/status')
      return Response.json({ result: { model: 'faux/voice', route: 'audio' } })
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

beforeEach(({ onTestFinished }) => {
  harness.sources.length = 0
  harness.turns.length = 0
  vi.stubGlobal('speechSynthesis', { cancel: () => undefined, speak: () => undefined })
  dock.setCuesOn(false)
  clientStore.start()
  onTestFinished(() => clientStore.stop())
  harness.sources[0].open()
  settleTranscripts({ of: parseConversationId(1), draft: [clip] }, session)
  getDraft(session).set({ images: [shot] })
})
afterEach(() => {
  vi.unstubAllGlobals()
  getDraft(session).set({ images: [] })
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
