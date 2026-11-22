import { createAgent } from '@ui-sdk/solid/agent'
import { settle } from '@ui-sdk/core/testing'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { ExtensionName, ROOT } from '@/sdk/solid'
import { parseConversationId } from '../../../../lib/ids.ts'
import { SOURCE_HEADER } from '../../../../shared/protocol.ts'
import type { SystemInfo, UiUpdateRequest } from '../../../../shared/protocol.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { store, uiState } from '../../../../web/src/sdk/client.ts'
import { WorkspacesDoc } from '../../../workspaces/refs.ts'
import type { Workspace, WorkspaceStats } from '../../../workspaces/types.ts'
import { InfoPanel } from '../../panel.solid.tsx'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  writes: [] as { key: string; value: unknown; source: string | null }[],
  restarts: 0,
}))

const repo = '/home/test/project'
const workspace = {
  path: `${repo}/checkouts/7`,
  branch: 'main',
  source: repo,
  target: 'main',
  base: '56789ab',
  state: 'ready',
} satisfies Workspace

vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    if (path === '/api/ui') {
      const { ops } = JSON.parse(init!.body as string) as UiUpdateRequest
      const source = new Headers(init?.headers).get(SOURCE_HEADER)
      for (const { key, value } of ops) harness.writes.push({ key, value, source })
      return Response.json({ ok: true, rev: 1 })
    }
    if (path === '/api/restart') harness.restarts++
    if (path === '/api/models') return Response.json({ providers: [], models: [] })
    if (path === '/api/extensions/workspaces/actions/info')
      return Response.json({ result: { ...workspace, ahead: 2 } })
    if (path === '/api/extensions/workspaces/actions/stats')
      return Response.json({
        result: {
          total: 1,
          ready: 1,
          preparing: 0,
          failed: 0,
          removed: 0,
          ahead: 1,
          landed: 0,
          fresh: 0,
          dirty: 0,
        } satisfies WorkspaceStats,
      })
    if (path === '/api/extensions/workspaces/actions/disk')
      return Response.json({ result: { bytes: 2000, real: null, at: 0 } })
    return harness.server?.handle(path, init) ?? Response.json({ ok: true })
  }
  const { answerReadsWith } = await import('../../../../test/web/fake-source.ts')
  const pageFetch = answerReadsWith(fetch)
  const clientStore = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch: pageFetch,
  })
  const api = createApi(clientStore, { fetch: pageFetch })
  return {
    store: clientStore,
    api,
    reads: createReads(api, clientStore),
    uiState: createUiState(api.updateUi),
  }
})

const system: SystemInfo = {
  build: {
    id: 'abcdef012',
    at: '2026-05-01T00:00:00Z',
    generation: 1,
    changed: [],
    core: '1234567',
    lib: '',
    extensions: {},
    history: [],
  },
  code: { ultimateRoot: repo, branch: 'main', sha: 'abcdef0', dirty: true, coreStale: true },
  machine: {
    hostname: 'example',
    home: '/home/test',
    user: 'test',
    platform: 'linux',
    release: '6.0',
    arch: 'x64',
    cpuModel: 'CPU',
    cpuCount: 4,
    totalMemory: 2 ** 34,
    freeMemory: 2 ** 33,
  },
  process: {
    pid: 42,
    generation: 1,
    startedAt: '2026-05-01T00:00:00Z',
    node: 'v26.0.0',
    url: 'http://localhost:4747',
  },
  execution: { kind: 'node-local', defaultCwd: repo },
  access: { origins: [] },
  project: { root: repo, name: 'project', config: false, decision: null, settings: {} },
  persistence: { kind: 'sqlite', path: '/home/test/state.sqlite', sizeBytes: 8192, walBytes: 4096 },
  web: { id: 'test', changed: [] },
  extensions: [],
  extensionDiagnostics: [],
  skills: [
    {
      name: 'verify-ui',
      description: 'Check the UI',
      path: `${repo}/skills/verify-ui/SKILL.md`,
      scope: 'clone',
      overrides: [],
    },
  ],
  skillDiagnostics: [],
  contextFiles: [`${repo}/AGENTS.md`, `${repo}/subproject/AGENTS.md`],
}

const agent = createAgent({ allow: (step) => !step.confirm })
harness.server = fakeSubscriptions(harness.sources)

it('names all Info controls and persists an agent’s collapsed section', async ({
  onTestFinished,
}) => {
  const id = parseConversationId(7)
  const conversation = { id, busy: false }
  store.start()
  onTestFinished(() => store.stop())
  const stream = harness.sources[0]
  stream.open()
  stream.send('system', system)
  stream.send('conversations', [conversation])
  const container = renderSolid(() => (
    <ExtensionName value="info">
      <InfoPanel />
    </ExtensionName>
  ))
  await settle()
  harness.server!.of()!.send('view', {
    conversation,
    entries: [],
    docs: { 'pi.agent': { cwd: workspace.path } },
  })
  harness.server!.of(ROOT)!.send('doc', {
    kind: WorkspacesDoc.kind,
    value: { items: { [id]: workspace }, queue: [] },
  })
  await settle()
  flush()

  const controls = agent.snapshot().filter((entry) => !entry.offPage)
  const sections = controls.filter((entry) => entry.component === 'collapsible' && entry.open)
  for (const label of ['Restart host from Code', 'Restart host from Process']) {
    const restart = controls.find((entry) => entry.label === label)!
    expect(restart.confirm).toBe('Restarts the shared Ultimate host.')
    expect((await agent.act({ steps: [{ ref: restart.ref, action: 'press' }] })).ok).toBe(false)
  }
  expect(harness.restarts).toBe(0)
  await expectDistinctAgentNames(agent)

  const changes = vi.fn<Parameters<typeof agent.subscribe>[0]>()
  onTestFinished(agent.subscribe(changes))
  const machine = sections.find((item) => item.label === 'Machine section')!
  expect(
    await agent.act({ steps: [{ ref: machine.ref, action: 'setOpen', args: [false] }] }),
  ).toMatchObject({ ok: true })
  flush()
  expect(container.querySelector('[aria-label="Memory utilization"]')).toBeNull()
  await uiState.flush()
  expect(harness.writes).toEqual([{ key: 'ext.info.closed', value: ['machine'], source: 'agent' }])
  expect(changes).toHaveBeenCalledWith(
    expect.objectContaining({
      label: 'Machine section',
      key: 'open',
      value: false,
      source: 'agent',
    }),
  )
})
