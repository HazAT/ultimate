import { createHash } from 'node:crypto'
import { cp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { expect, it, vi } from 'vitest'
import { context, prepareHarness } from '../../../../server/harness.ts'
import { Metadata } from '../../../../server/metadata.ts'
import { emit } from '../../../../server/events.ts'
import instance, { actions } from '../../server.ts'
import subagents from '../../../subagents/server.ts'
import { Subagents } from '../../../subagents/api.ts'
import workspaceExtension from '../../../workspaces/server.ts'
import { workspaces } from '../../../workspaces/workspaces.ts'
import { git } from '../../../../lib/git.ts'
import { projectSettings } from '../../../../server/project-setup.ts'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import type { ExtensionHost } from '../../../../server/extensions.ts'
import type { ConversationsService } from '../../../conversations/api.ts'
import { setAutomaticSummaries } from '../../../conversations/summary.ts'
import { setStanding } from '../../../conversations/server.ts'
import { apis, attach, post, temp, removeTemp, until } from '../../../../test/helpers.ts'
import { scriptedModel } from '../../../../test/e2e/scripted-model.ts'

type Preview = { id: string; url: string; home: string; pid: number }
async function assertProject(
  preview: Preview,
  path: string,
  decision: boolean | null,
  source = path,
) {
  const client = await attach(preview)
  try {
    expect(client.system().execution.defaultCwd).toBe(path)
    expect(client.system().code.ultimateRoot).toBe(source)
    expect(client.system().project.decision).toBe(decision)
    expect(client.system().persistence.path).toBe(join(preview.home, 'state.sqlite'))
    expect(client.system().process.pid).toBe(preview.pid)
  } finally {
    await client.close()
  }
  expect((await fetch(`${preview.url}/api/models`)).status).toBe(200)
}
async function fixture({ foreign = false } = {}) {
  const root = await temp('ultimate-preview-')
  // Child hosts must sweep only this fixture, never the machine's real temporary directory.
  vi.stubEnv('TMPDIR', root)
  const checkout = resolve('.')
  const source = join(root, 'source')
  await git(root, 'clone', '--no-hardlinks', checkout, source)
  await git(source, 'switch', '-c', 'preview-source')
  // The preview runs the clone's committed code: give it this checkout's preview and landing code.
  for (const path of ['extensions/instance', 'extensions/workspaces', 'lib'])
    await cp(join(checkout, path), join(source, path), { recursive: true })
  await symlink(join(checkout, 'node_modules'), join(source, 'node_modules'))
  await writeFile(
    join(source, '.ultimate/settings.json'),
    JSON.stringify({
      isolates: { worktree: { setup: [`ln -s '${join(checkout, 'node_modules')}' node_modules`] } },
    }),
  )
  await writeFile(
    join(source, '.gitignore'),
    (await readFile(join(source, '.gitignore'), 'utf8')) + '\n/node_modules\n',
  )
  await git(
    source,
    'add',
    '.ultimate/settings.json',
    '.gitignore',
    'extensions/instance',
    'extensions/workspaces',
    'lib',
  )
  await git(source, 'commit', '-m', 'Configure preview setup')
  const project = foreign ? join(root, 'app') : source
  if (foreign) {
    await git(root, 'init', '-b', 'main', project)
    await writeFile(join(project, 'README.md'), 'An app, not Ultimate\n')
    await git(project, 'add', 'README.md')
    await git(project, 'commit', '-m', 'Start app')
  }
  new ProjectTrustStore(join(root, '.ultimate')).set(project, true)
  // Faux previews publish on Tailscale; keep them off the machine's real tailnet.
  await writeFile(
    join(root, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['tailscale'] } }),
  )
  const prepared = await prepareHarness({
    ultimateRoot: source,
    projectRoot: project,
    home: join(root, 'home'),
    userHome: root,
    faux: fauxProvider(),
  })
  let opened: Awaited<ReturnType<typeof prepared.open>>
  const resources = new Map<string, unknown>()
  const services = new Map<string, unknown>()
  const cleanups: (() => Promise<void>)[] = []
  const host = {
    ...prepared,
    projectSettings: () => projectSettings(project, root),
    harness: () => opened.harness,
    metadata: Metadata,
    emit,
    ...apis(services),
    extensions: () => [{ name: 'workspaces', enabled: true }],
    resource<T>(key: string, create: () => T): T {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
    onOpen: () => {},
    onClose: (cleanup: () => Promise<void>) => {
      cleanups.push(cleanup)
    },
  } as unknown as ExtensionHost
  // The core's conversations: nothing concluded, no summaries.
  services.set('conversations', {
    concluded: async () => new Set(),
    summaryModel: async () => undefined,
    requestSummary: async () => {},
    setAutomaticSummaries,
    setStanding,
  } satisfies Partial<ConversationsService>)
  const extension = instance(host)
  const service = workspaces(host)
  prepared.registry.install(workspaceExtension(host))
  prepared.registry.install(subagents(host))
  prepared.registry.install(extension)
  const route: FauxResponseFactory = (transcript) => {
    prepared.faux!.appendResponses([route])
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    if (
      last.role === 'user' &&
      typeof last.content === 'string' &&
      last.content.startsWith('CALL ')
    ) {
      const { tool, args } = JSON.parse(last.content.slice(5))
      return fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: 'toolUse' })
    }
    return fauxAssistantMessage([fauxText('Finished')])
  }
  prepared.faux!.setResponses([route])
  opened = await prepared.open()
  async function call(tool: string, args: object, id = opened.root.id) {
    const conversation = (await opened.harness.conversation(id, context))!
    await (
      await conversation.submit(
        { type: 'input', content: `CALL ${JSON.stringify({ tool, args })}` },
        context,
      )
    ).wait(context)
    const view = await conversation.context(context)
    const result = view.entries.filter((entry) => entry.kind === 'pi.tool-result').at(-1)
      ?.model?.[0]
    if (result?.role !== 'toolResult') throw new Error('Missing tool result')
    return result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
  }
  async function run(
    args: Parameters<NonNullable<typeof extension.tools>[number]['execute']>[0],
    id = opened.root.id,
    ctx = context,
  ) {
    const result = await extension.tools![0].execute(
      args,
      {
        conversationId: id,
        snapshot: opened.harness.snapshot.bind(opened.harness),
        output: () => {},
      } as never,
      ctx,
    )
    return result.output!.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
  }
  async function main() {
    const conversation = await opened.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { model: { provider: 'faux', modelId: 'faux-1' } },
        init: (tx, id) => service.create(tx, id, project).then(() => undefined),
      },
      context,
    )
    await service.ready(conversation.id, context)
    return { id: conversation.id, workspace: (await service.get(conversation.id, context))! }
  }
  async function close() {
    const previews = JSON.parse(await run({ action: 'list' })) as Preview[]
    for (const cleanup of cleanups) await cleanup()
    await opened.close()
    for (const preview of previews) await removeTemp(preview.home)
    await removeTemp(root)
    vi.unstubAllEnvs()
  }
  const list = async () =>
    (await actions.list(null, { host } as never)) as (Omit<Preview, 'home' | 'pid'> & {
      tailnet?: string
      running: boolean
    })[]
  return {
    root,
    source,
    prepared,
    opened,
    service,
    services,
    call,
    run,
    list,
    main,
    close,
    stopAll: async () => {
      for (const cleanup of cleanups) await cleanup()
    },
  }
}
const listed = (preview: Preview, conversationId: number) => ({
  id: preview.id,
  url: preview.url,
  conversationId,
  running: true,
})
it('selects shared, isolated main and owned child checkouts with the main project decision', async () => {
  const f = await fixture()
  try {
    expect(await f.call('instance', { action: 'start', subagent: 999999 })).toContain(
      'Unknown subagent',
    )
    const main = await f.main()
    const own = JSON.parse(await f.call('instance', { action: 'start' }, main.id)) as Preview
    expect(
      await f.call(
        'subagent',
        { action: 'start', agent: 'worker', task: 'Finish without tools', isolate: 'worktree' },
        main.id,
      ),
    ).toContain('Isolate:')
    const child = Object.values(
      (await f.opened.harness.snapshot(Subagents, main.id, context))!.agents,
    )[0]
    const childWorkspace = (await f.service.get(child.conversationId, context))!
    expect(childWorkspace.source).toBe(main.workspace.path)
    const shared = JSON.parse(await f.call('instance', { action: 'start' })) as Preview
    const selected = JSON.parse(
      await f.call('instance', { action: 'start', subagent: child.conversationId }, main.id),
    ) as Preview
    expect(new Set([shared.url, own.url, selected.url]).size).toBe(3)
    expect(new Set([shared.home, own.home, selected.home, f.prepared.home]).size).toBe(4)
    await assertProject(shared, f.source, true)
    await assertProject(own, main.workspace.path, true)
    await assertProject(selected, childWorkspace.path, true)
    expect(await f.run({ action: 'start' })).toContain('At most three')
    expect(await f.list()).toEqual(
      expect.arrayContaining([
        listed(own, main.id),
        listed(shared, f.opened.root.id),
        listed(selected, child.conversationId),
      ]),
    )
    // A preview's own tailscale extension registers its port under its pid; the host's status names the DNS name.
    await writeFile(
      join(f.root, '.ultimate/tailscale.json'),
      JSON.stringify({
        ports: {
          [main.workspace.path]: { port: 41234, owner: `${own.pid}:token` },
          '/elsewhere': { port: 41235, owner: '1:token' },
        },
      }),
    )
    expect((await f.list()).every((preview) => !('tailnet' in preview))).toBe(true)
    f.services.set('tailscale', {
      status: () => ({ state: 'ready', url: 'https://rog.example.ts.net:4747', allow: [] }),
    })
    expect(
      Object.fromEntries((await f.list()).map((preview) => [preview.id, preview.tailnet])),
    ).toEqual({
      [own.id]: 'https://rog.example.ts.net:41234',
      [shared.id]: undefined,
      [selected.id]: undefined,
    })
    for (const [preview, conversationId] of [
      [selected, child.conversationId],
      [shared, f.opened.root.id],
      [own, main.id],
    ] as const) {
      expect(await f.call('instance', { action: 'logs', id: preview.id })).toContain(preview.url)
      await f.run({ action: 'stop', id: preview.id })
      // Stopped previews stay listed as not running, without a tailnet address, so links to them can say so.
      expect((await f.list()).find(({ id }) => id === preview.id)).toEqual({
        ...listed(preview, conversationId),
        running: false,
      })
      await removeTemp(preview.home)
    }
    await f.service.discard(child.conversationId, context)
    await f.service.discard(main.id, context)
    expect(await f.run({ action: 'start' }, main.id)).toContain('active, ready')
  } finally {
    await f.close()
  }
}, 120000)
it('previews a workspace of another project on the host Ultimate', async () => {
  const f = await fixture({ foreign: true })
  try {
    const main = await f.main()
    const preview = JSON.parse(await f.call('instance', { action: 'start' }, main.id)) as Preview
    expect(await readFile(join(main.workspace.path, 'README.md'), 'utf8')).toContain('not Ultimate')
    await assertProject(preview, main.workspace.path, true, f.source)
    await f.run({ action: 'stop', id: preview.id })
  } finally {
    await f.close()
  }
}, 120000)
it('cleans up a failed or aborted preview and allows its home to be reused', async () => {
  const f = await fixture()
  try {
    const main = await f.main()
    const entry = join(main.workspace.path, 'server/main.ts')
    const original = await readFile(entry, 'utf8')
    await writeFile(entry, "throw new Error('preview startup failure')\n")
    const home = join(f.root, 'failed-home')
    expect(await f.run({ action: 'start', home }, main.id)).toContain('preview startup failure')
    expect(JSON.parse(await f.run({ action: 'list' }))).toEqual([])
    await writeFile(entry, 'setInterval(() => {}, 1000)\n')
    const controller = new AbortController()
    const abort = f.run({ action: 'start', home }, main.id, {
      ...context,
      abortSignal: controller.signal,
    })
    await until(async () => JSON.parse(await f.run({ action: 'list' })).length === 1)
    controller.abort()
    expect(await abort).toContain('AbortError')
    expect(JSON.parse(await f.run({ action: 'list' }))).toEqual([])
    await writeFile(entry, original)
    const preview = JSON.parse(await f.run({ action: 'start', home }, main.id)) as Preview
    const retained = join(home, 'worktrees', 'retained')
    await git(f.source, 'worktree', 'add', '-b', 'retained-preview', retained)
    process.kill(preview.pid, 'SIGTERM')
    await until(async () => JSON.parse(await f.run({ action: 'list' })).length === 0)
    // Exited on its own, the preview stays listed as not running; a start that failed never was.
    expect((await f.list()).map(({ id, running }) => ({ id, running }))).toEqual([
      { id: preview.id, running: false },
    ])
    await f.run({ action: 'stop', id: preview.id })
    expect((await stat(home)).isDirectory()).toBe(true)
    expect(await git(f.source, 'worktree', 'list', '--porcelain')).toContain(retained)
    expect(await git(f.source, 'branch', '--format=%(refname)')).toContain(
      'refs/heads/retained-preview',
    )
    expect((await f.list()).map(({ id, running }) => ({ id, running }))).toEqual([
      { id: preview.id, running: false },
    ])
  } finally {
    await f.close()
  }
}, 120000)

// A stop and a start of the same home in one tool round ran side by side, and the start found the home still owned
// (omarchy-config #78009).
it('restarts a home whose stop runs alongside the start', async () => {
  const f = await fixture()
  try {
    const main = await f.main()
    const home = join(f.root, 'restart-home')
    const first = JSON.parse(await f.run({ action: 'start', home }, main.id)) as Preview
    const [stopped, started] = await Promise.all([
      f.run({ action: 'stop', id: first.id }),
      f.run({ action: 'start', home }, main.id),
    ])
    expect(stopped).toBe(JSON.stringify({ stopped: first.id }))
    const second = JSON.parse(started) as Preview
    expect(JSON.parse(await f.run({ action: 'list' }))).toEqual([second])
    await f.run({ action: 'stop', id: second.id })
  } finally {
    await f.close()
  }
}, 120000)

// A preview of a branch landed its own submissions onto that branch and pushed it to origin.
it('lands a preview submission on its own branch, never the previewed branch or a remote', async () => {
  const f = await fixture()
  const model = await scriptedModel(({ role, text }) =>
    role === 'user' && text === 'submit'
      ? { tool: { name: 'workspace', args: { action: 'submit', divergence: 'None' } } }
      : { text: 'Done.' },
  )
  try {
    const remote = join(f.root, 'remote.git')
    await git(f.root, 'init', '-q', '--bare', remote)
    await git(f.source, 'remote', 'set-url', 'origin', remote)
    const settings = join(f.source, '.ultimate/settings.json')
    await writeFile(
      settings,
      JSON.stringify({
        ...JSON.parse(await readFile(settings, 'utf8')),
        lander: { push: 'origin' },
      }),
    )
    await git(f.source, 'commit', '-qam', 'Push landings')
    await writeFile(
      join(f.root, '.ultimate/settings.json'),
      JSON.stringify({
        extensions: { disable: ['tailscale'] },
        instance: { model: 'scripted/scripted-1' },
      }),
    )
    vi.stubEnv('PI_CODING_AGENT_DIR', model.env.PI_CODING_AGENT_DIR)
    const main = await f.main()
    const before = await git(f.source, 'rev-parse', main.workspace.branch)
    const preview = JSON.parse(await f.run({ action: 'start' }, main.id)) as Preview
    const action = async (name: string, args: object) => {
      const { status, data } = await post(preview, `/api/extensions/workspaces/actions/${name}`, {
        args,
      })
      if (status !== 200) throw new Error(`${name}: ${status} ${JSON.stringify(data)}`)
      return (data as { result: unknown }).result as {
        id: number
        path: string
        state: string
        target: string
        landed?: string
      }
    }
    const { id } = await action('create', {})
    await until(async () => (await action('info', { id })).state === 'ready')
    const workspace = await action('info', { id })
    await writeFile(join(workspace.path, 'preview.txt'), 'preview')
    await git(workspace.path, 'add', 'preview.txt')
    await git(workspace.path, 'commit', '-qm', 'Preview change')
    expect(
      (await post(preview, `/api/conversations/${id}/submit`, { text: 'submit' })).status,
    ).toBe(202)
    await until(async () => (await action('info', { id })).landed !== undefined)
    const { landed, target } = await action('info', { id })
    expect(target).not.toBe(main.workspace.branch)
    expect(await git(f.source, 'rev-parse', target)).toBe(landed)
    expect(await git(f.source, 'rev-parse', main.workspace.branch)).toBe(before)
    expect(await git(remote, 'for-each-ref')).toBe('')
    expect(await f.run({ action: 'stop', id: preview.id })).toBe(
      JSON.stringify({ stopped: preview.id }),
    )
    expect(await git(f.source, 'branch', '--list', target)).toBe('')
  } finally {
    await model.close()
    await f.close()
  }
}, 120000)

it('removes preview registrations, branches and temporary homes on stop and shutdown', async () => {
  const f = await fixture()
  try {
    const beforeTrees = await git(f.source, 'worktree', 'list', '--porcelain')
    const beforeBranches = await git(f.source, 'branch', '--format=%(refname)')
    for (const shutdown of [false, true]) {
      const preview = JSON.parse(await f.run({ action: 'start' })) as Preview
      await until(async () =>
        (await git(f.source, 'worktree', 'list', '--porcelain')).includes(preview.home),
      )
      // Include a dirty, branch-backed preview isolate as well as the detached lander created on open.
      const worker = join(preview.home, 'worktrees', 'test')
      const branch = `ultimate/${createHash('sha256').update(preview.home).digest('hex').slice(0, 6)}-1`
      await git(f.source, 'worktree', 'add', '-b', branch, worker)
      await writeFile(join(worker, 'scratch'), 'uncommitted preview scratch')
      if (shutdown) await f.stopAll()
      else await f.run({ action: 'stop', id: preview.id })
      expect(await stat(preview.home).catch(() => undefined)).toBeUndefined()
      expect(await git(f.source, 'worktree', 'list', '--porcelain')).toBe(beforeTrees)
      expect(await git(f.source, 'branch', '--format=%(refname)')).toBe(beforeBranches)
    }
  } finally {
    await f.close()
  }
}, 120000)
