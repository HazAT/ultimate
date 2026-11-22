import type { ConversationId } from '@earendil-works/pi-durable'
import { createAgent } from '@ui-sdk/solid/agent'
import { settle } from '@ui-sdk/core/testing'
import { flush } from 'solid-js'
import { beforeEach, expect, it, vi } from 'vitest'
import { EVENT_FEED } from '../../../../shared/events.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { BackupAction, BackupEvent, JoinAction, JoinStateAction, StateAction } from '../../refs.ts'
import type { JoinState } from '../../refs.ts'
import type { CloudState, LastBackup } from '../../types.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  requests: [] as { path: string; args: unknown; source: string | null }[],
  state: { status: 'on', name: 'example' } as CloudState,
  join: undefined as unknown as JoinState,
  joinFails: [] as ('secrets' | 'settings' | 'check' | 'lost')[],
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    if (!path.startsWith('/api/extensions/cloud/actions/'))
      return subscriptions.handle(path, init) ?? Response.json({ ok: true })
    const { args } = JSON.parse(init!.body as string) as { args: unknown }
    harness.requests.push({
      path,
      args,
      source: new Headers(init?.headers).get('x-ultimate-source'),
    })
    if (path === endpoint(BackupAction)) {
      const lastBackup: LastBackup = {
        id: 'new',
        machine: 'test-machine',
        at: Date.now(),
        bytes: 2000,
        uploaded: 1000,
      }
      harness.state = { ...harness.state, lastBackup }
      return Response.json({ result: lastBackup })
    }
    if (path === endpoint(JoinAction)) {
      const { url, machine } = args as { url: string; machine: string }
      const step = harness.joinFails.shift()
      if (step) {
        if (step !== 'check') harness.join = { ...harness.join, missing: [] }
        if (step === 'lost') return Response.json({ error: 'Bad gateway' }, { status: 502 })
        return Response.json({ result: { ok: false, step, error: `Failed at ${step}` } })
      }
      const joined = { url, machine, host: new URL(url).host }
      harness.join = { url, machine, missing: [], joined }
      return Response.json({ result: { ok: true, ...joined, projects: ['example'] } })
    }
    return Response.json({
      result: path === endpoint(JoinStateAction) ? harness.join : harness.state,
    })
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

import { reads, store } from '../../../../web/src/sdk/client.ts'
import { JoinDialog, joinDialog } from '../../join.solid.tsx'
import { CloudStatus } from '../../status.solid.tsx'

const endpoint = (ref: { extension: string; name: string }) =>
  `/api/extensions/${ref.extension}/actions/${ref.name}`
const subscriptions = fakeSubscriptions(harness.sources)
const agent = createAgent()
async function openJoinDialog() {
  await reads
    .get(JoinStateAction.extension, JoinStateAction.name, null, 1 as ConversationId)
    .refetch()
  const container = renderSolid(() => <JoinDialog />)
  store.setUi({ dialogs: { [joinDialog]: true } })
  flush()
  await settle()
  await expectDistinctAgentNames(agent)
  return container
}
const control = (label: string) =>
  agent.snapshot().find((entry) => !entry.offPage && entry.label === label)

beforeEach(({ onTestFinished }) => {
  harness.requests.length = 0
  harness.joinFails = []
  harness.join = {
    machine: 'old-machine',
    missing: ['ULTIMATE_CLOUD_TOKEN', 'ULTIMATE_CLOUD_SNAPSHOT_KEY'],
  }
  store.start()
  onTestFinished(() => store.stop())
  harness.sources.at(-1)!.open()
})

it('lets an agent open Cloud backup and back up now, then refreshes the status', async () => {
  const container = renderSolid(() => <CloudStatus />)
  await settle()
  flush()
  expect(
    (await agent.act({ steps: [{ ref: 'Cloud backup', action: 'setOpen', args: [true] }] })).ok,
  ).toBe(true)
  await expectDistinctAgentNames(agent)

  const backup = control('Back up now')
  expect(backup?.actions).toContain('press')
  expect((await agent.act({ steps: [{ ref: backup!.ref, action: 'press' }] })).ok).toBe(true)
  expect(harness.requests).toContainEqual({
    path: endpoint(BackupAction),
    args: null,
    source: 'agent',
  })
  expect(container.querySelector('[data-cloud-backup]')?.textContent).toContain('from test-machine')

  const afterBackup = harness.requests.length
  harness.state = { ...harness.state, backup: { done: 20, total: 100, uploaded: 5 } }
  subscriptions.subscriptions
    .find((subscription) => !subscription.closed && subscription.docs.includes(EVENT_FEED))!
    .send('doc', {
      kind: EVENT_FEED,
      value: { events: [{ id: 1, kind: BackupEvent.kind }] },
    })
  await settle()
  flush()
  expect(harness.requests.slice(afterBackup).map(({ path }) => path)).toContain(
    endpoint(StateAction),
  )
  expect(container.querySelector('progress')?.value).toBe(20)
})

it('refuses an agent replacing a stored cloud secret without a person confirming', async () => {
  harness.join = { machine: 'old-machine', missing: ['ULTIMATE_CLOUD_TOKEN'] }
  await openJoinDialog()
  const before = harness.requests.length
  const filled = await agent.act({
    steps: [
      { ref: 'Cloud URL', action: 'setValue', args: ['wss://next.example.test'] },
      { ref: 'ULTIMATE_CLOUD_TOKEN', action: 'setValue', args: ['fake-token'] },
      { ref: 'ULTIMATE_CLOUD_SNAPSHOT_KEY', action: 'setValue', args: ['fake-key'] },
    ],
  })
  expect(filled.ok).toBe(true)
  flush()
  const saved = await agent.act({ steps: [{ ref: 'Save cloud connection', action: 'press' }] })
  expect(saved.ok).toBe(false)
  expect(saved.error?.message).toContain('Replaces the cloud secrets stored on this machine')
  await settle()
  expect(harness.requests.slice(before).map(({ path }) => path)).not.toContain(endpoint(JoinAction))
})

it('lets an agent fill the four join fields and submits the exact JoinAction args without exposing the secrets', async ({
  onTestFinished,
}) => {
  const container = await openJoinDialog()
  const args = {
    url: 'wss://cloud.example.test',
    machine: 'new-machine',
    token: 'fake-token',
    snapshotKey: 'fake-key',
  }
  const fields = [
    ['Cloud URL', args.url],
    ['Machine name', args.machine],
    ['ULTIMATE_CLOUD_TOKEN', args.token],
    ['ULTIMATE_CLOUD_SNAPSHOT_KEY', args.snapshotKey],
  ]
  const changes = vi.fn<Parameters<typeof agent.subscribe>[0]>()
  onTestFinished(agent.subscribe(changes))
  const filled = await agent.act({
    steps: fields.map(([label, value]) => {
      const field = control(label)
      expect(field?.actions).toContain('setValue')
      return { ref: field!.ref, action: 'setValue', args: [value] }
    }),
  })
  expect(filled.ok).toBe(true)
  expect(JSON.stringify([agent.snapshot(), filled, changes.mock.calls])).not.toMatch(
    /fake-token|fake-key/,
  )

  const saved = await agent.act({ steps: [{ ref: 'Save cloud connection', action: 'press' }] })
  expect(saved.ok).toBe(true)
  expect(harness.requests).toContainEqual({ path: endpoint(JoinAction), args, source: 'agent' })
  expect(container.querySelector('[data-cloud-join-next]')?.textContent).toContain(
    '1 project in the cloud',
  )
  expect(container.querySelector('[data-cloud-join] input')).toBeNull()
})

it.each(['secrets', 'settings', 'lost'] as const)(
  'keeps asking a person before an agent retries a join that failed at %s, after any later failure',
  async (step) => {
    harness.joinFails = [step, 'check']
    await openJoinDialog()
    const filled = await agent.act({
      steps: [
        { ref: 'Cloud URL', action: 'setValue', args: ['wss://cloud.example.test'] },
        { ref: 'ULTIMATE_CLOUD_TOKEN', action: 'setValue', args: ['fake-token'] },
        { ref: 'ULTIMATE_CLOUD_SNAPSHOT_KEY', action: 'setValue', args: ['fake-key'] },
      ],
    })
    expect(filled.ok).toBe(true)
    flush()
    const save = () => agent.act({ steps: [{ ref: 'Save cloud connection', action: 'press' }] })
    expect((await save()).ok).toBe(true)
    await settle()
    flush()
    expect((await save()).ok).toBe(false)
    const button = [...document.querySelectorAll('button')].find(
      (element) => element.textContent?.trim() === 'Save cloud connection',
    )!
    button.click()
    await settle()
    flush()
    expect((await save()).ok).toBe(false)
    await settle()
    expect(harness.requests.filter(({ path }) => path === endpoint(JoinAction))).toHaveLength(2)
  },
)
