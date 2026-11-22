import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import type { Component } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  available: false,
}))

vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const subscriptions = (harness.server = fakeSubscriptions(harness.sources))
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    if (path === '/api/extensions/voice-live/actions/status')
      return Response.json({ result: { available: harness.available } })
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

import { store } from '../../../../web/src/sdk/client.ts'
import { events } from '@/sdk/solid'
import * as live from '../../live.solid.tsx'
import web from '../../web.solid.tsx'

const agent = createAgent()
const [Start] = web.slots!['composer.actions'] as Component[]

it('opens Secrets from the relay button and updates when the key becomes available', async ({
  onTestFinished,
}) => {
  const main = parseConversationId(44)
  const openSecrets = vi.fn<(data: unknown) => void>()
  onTestFinished(events.on('secrets:open', openSecrets))
  store.start()
  onTestFinished(() => store.stop())
  harness.sources[0].open()
  store.show(main)
  const container = renderSolid(() => <Start />)
  await settle()
  harness.server!.of(main)!.send('view', {
    conversation: { id: main },
    entries: [],
    docs: {},
  })
  harness
    .server!.of(1)!
    .send('doc', { kind: 'ultimate.standing-agents', value: { ultimate: main } })
  await settle()
  flush()
  const label = 'Voice relay needs an OpenAI API key: tap to add it'
  const button = container.querySelector('button[data-voice-live="unavailable"]')!
  expect(button.getAttribute('aria-label')).toBe(label)
  const control = agent.snapshot().find((entry) => !entry.offPage && entry.label === label)
  expect(control).toMatchObject({ component: 'button', label, actions: ['press'] })
  for (const _ of [1, 2]) {
    expect(await agent.act({ steps: [{ ref: control!.ref, action: 'press' }] })).toMatchObject({
      ok: true,
    })
  }
  expect(openSecrets.mock.calls).toEqual([
    [{ name: 'OPENAI_API_KEY' }],
    [{ name: 'OPENAI_API_KEY' }],
  ])

  harness.available = true
  events.emit('secrets:changed', undefined)
  await settle()
  flush()
  expect(button.getAttribute('data-voice-live')).toBe('off')
  expect(button.getAttribute('aria-label')).toBe(
    'Start voice relay: talk to @ultimate, hear its answers',
  )
})

it('sets microphone mute to the requested value without publishing duplicate requests', () => {
  const before = live.voiceMode()
  live.setMuted(true)
  const muted = live.voiceMode()
  expect(muted).toEqual({ ...before, muted: true })
  live.setMuted(true)
  expect(live.voiceMode()).toBe(muted)
  live.setMuted(false)
  const unmuted = live.voiceMode()
  expect(unmuted).toEqual(before)
  live.setMuted(false)
  expect(live.voiceMode()).toBe(unmuted)
})
