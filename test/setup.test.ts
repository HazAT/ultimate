import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConversationId, JsonObject, Tx } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { fallbackModel, summaryModelStatus } from '../extensions/conversations/summary-model.ts'
import { check, noteFor } from '../extensions/setup/server.ts'
import type { SetupIssue } from '../extensions/setup/refs.ts'
import { git } from '../lib/git.ts'
import { removeTemps, temp } from './helpers.ts'

afterEach(removeTemps)

const model = (provider: string, id: string, cost = 1) => ({
  provider,
  id,
  reasoning: true,
  cost: { input: cost, output: cost, cacheRead: 0, cacheWrite: 0 },
})

async function summaryHost(available: ReturnType<typeof model>[], project = {}) {
  const notices: string[] = []
  return {
    notices,
    host: {
      userHome: await temp('ultimate-setup-'),
      projectSettings: async () => project,
      notice: (message: string) => void notices.push(message),
      modelRuntime: { getAvailableSnapshot: () => available as never },
    },
  }
}

it('falls back from a default summary model without a login, and says so once', async () => {
  const { host, notices } = await summaryHost([
    model('openrouter', 'some/expensive', 5),
    model('openrouter', 'anthropic/claude-haiku-5.5', 2),
  ])
  const status = await summaryModelStatus(host)
  expect(status).toMatchObject({
    model: { provider: 'openrouter', id: 'anthropic/claude-haiku-5.5' },
    configured: 'openai-codex/gpt-6-luna:low',
    fellBack: true,
  })
  await summaryModelStatus(host)
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain('using openrouter/anthropic/claude-haiku-5.5 instead')
})

it('never falls back from a summary model the settings name', async () => {
  const { host } = await summaryHost([model('openrouter', 'x')], {
    summaryModel: 'openai-codex/gpt-6-luna',
  })
  expect(await summaryModelStatus(host)).toEqual({
    configured: 'openai-codex/gpt-6-luna',
    source: 'project',
    problem: 'unavailable',
  })
})

it('falls back to the cheapest model when no known-good one is available', () => {
  expect(fallbackModel([model('a', 'big', 9), model('b', 'small', 1)] as never)).toMatchObject({
    provider: 'b',
    id: 'small',
  })
  expect(fallbackModel([])).toBeUndefined()
})

async function checkHost(options: { logins: string[]; secrets?: string[] }) {
  const userHome = await temp('ultimate-setup-check-')
  const projectRoot = join(userHome, 'project')
  await mkdir(join(userHome, '.ultimate/agents'), { recursive: true })
  await writeFile(
    join(userHome, '.ultimate/agents/scout.md'),
    '---\nname: scout\ndescription: Scouts\nmodel: openai-codex/gpt-6.1-sol\n---\nScout.\n',
  )
  const codex = model('openai-codex', 'gpt-6.1-sol')
  return {
    ultimateRoot: join(userHome, 'clone'),
    projectRoot,
    userHome,
    faux: undefined,
    modelRuntime: {
      getModels: () => [codex],
      getAvailableSnapshot: () => [],
      hasConfiguredAuth: (provider: string) => options.logins.includes(provider),
      getProviderAuthStatus: (provider: string) => ({
        configured: options.logins.includes(provider),
      }),
    },
    projectSettings: async () => ({ lander: { checks: ['pnpm check'] } }),
    extensions: () => [
      {
        name: 'parallel',
        enabled: true,
        server: {
          tools: [],
          sections: [],
          hooks: 0,
          docs: [],
          secrets: [{ name: 'PARALLEL_API_KEY', description: '' }],
        },
      },
    ],
    need: () => ({
      summaryModelStatus: async () => ({
        model: { provider: 'openrouter', id: 'haiku', thinking: 'medium' },
        configured: 'openai-codex/gpt-6-luna:low',
        source: 'default',
        fellBack: true,
      }),
    }),
    want: () => undefined,
    doc: () => undefined,
  } as unknown as Parameters<typeof check>[0]
}

it('warns about a fallback, agent models without a login and a missing secret, warnings first', async () => {
  const issues = await check(await checkHost({ logins: ['openrouter'] }))
  const warnings = issues.filter((issue) => issue.status === 'warn')
  expect(warnings.map((issue) => issue.area)).toEqual(['Summary model', 'Agent models', 'Secrets'])
  expect(warnings[0].impact).toContain('Using openrouter/haiku instead')
  // The pinned definition still loads; it fails at its first call.
  expect(warnings[1]).toMatchObject({
    summary: 'scout → openai-codex: no login here',
    impact: 'They fail at their first model call.',
  })
  expect(warnings[2]).toMatchObject({
    summary: 'PARALLEL_API_KEY missing',
    fix: { secret: 'PARALLEL_API_KEY' },
  })
  expect(issues.findIndex((issue) => issue.status !== 'warn')).toBe(3)
})

it('keeps the other areas when one throws synchronously', async () => {
  const host = await checkHost({ logins: ['openrouter'] })
  const issues = await check({
    ...host,
    extensions: () => {
      throw new Error('boom')
    },
  })
  expect(issues.find((issue) => issue.area === 'Summary model')?.status).toBe('warn')
  expect(issues.some((issue) => issue.summary === 'one check failed: boom')).toBe(true)
})

it("lets a provider's configured auth stand in for the secret that names it", async () => {
  const host = await checkHost({ logins: ['openrouter', 'typesafe'] })
  const secrets = [
    { name: 'TYPESAFE_API_KEY', description: '', provider: 'typesafe' },
    { name: 'OTHER_API_KEY', description: '', provider: 'other' },
  ]
  const issues = await check({
    ...host,
    extensions: () =>
      [
        {
          name: 'classify',
          enabled: true,
          server: { tools: [], sections: [], hooks: 0, docs: [], secrets },
        },
      ] as never,
  })
  expect(issues.find((issue) => issue.area === 'Secrets')).toMatchObject({
    status: 'warn',
    summary: 'OTHER_API_KEY missing',
  })
})

it('names each file that replaces a built-in definition whole, but not an overlay', async () => {
  const host = await checkHost({ logins: ['openrouter', 'openai-codex'] })
  const builtin = '---\nname: NAME\ndescription: Built in\ntools: [read]\n---\nBuilt-in body.\n'
  await mkdir(join(host.ultimateRoot, 'agents'), { recursive: true })
  for (const name of ['scout', 'ultimate'])
    await writeFile(join(host.ultimateRoot, `agents/${name}.md`), builtin.replace('NAME', name))
  await writeFile(
    join(host.userHome, '.ultimate/agents/ultimate.md'),
    '---\nname: ultimate\naddTools: [laravel]\n---\nAdded.\n',
  )
  // A settings-only overlay (an empty addTools) is no replacement either.
  await writeFile(
    join(host.userHome, '.ultimate/agents/reviewer.md'),
    '---\nname: reviewer\nthinking: high\naddTools: []\n---\n',
  )
  await writeFile(
    join(host.ultimateRoot, 'agents/reviewer.md'),
    builtin.replace('NAME', 'reviewer'),
  )
  const issues = (await check(host)).filter((issue) => issue.area === 'Agent definitions')
  expect(issues).toEqual([
    expect.objectContaining({
      status: 'warn',
      summary: '~/.ultimate/agents/scout.md replaces the built-in scout',
    }),
  ])
})

it('has no agent warning once the pinned provider has a login', async () => {
  const issues = await check(await checkHost({ logins: ['openrouter', 'openai-codex'] }))
  expect(issues.find((issue) => issue.area === 'Agent models')?.status).toBe('ok')
})

it('warns about a missing worktree setup until one is configured', async () => {
  const host = await checkHost({ logins: ['openrouter', 'openai-codex'] })
  await mkdir(host.projectRoot)
  await writeFile(join(host.projectRoot, 'composer.json'), '{}')
  await git(host.projectRoot, 'init', '-q', '-b', 'main')
  await git(
    host.projectRoot,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.com',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'first',
  )
  const workspaces = [...host.extensions(), { name: 'workspaces', enabled: true }] as ReturnType<
    typeof host.extensions
  >
  const row = async (settings: JsonObject) =>
    (
      await check({ ...host, extensions: () => workspaces, projectSettings: async () => settings })
    ).find((issue) => issue.area === 'Worktree setup')
  expect(await row({})).toMatchObject({
    status: 'warn',
    summary: 'none, though the project has composer.json',
  })
  expect(await row({ isolates: { worktree: { setup: ['composer install'] } } })).toMatchObject({
    status: 'ok',
  })
})

it('warns about a listed root without memories until it has one', async () => {
  const host = await checkHost({ logins: ['openrouter', 'openai-codex'] })
  const docs: Record<string, Record<number, JsonObject>> = {
    'lineage.roots': { 1: { roots: [1] } },
    'lineage.memory': { 1: { memories: {} } },
  }
  const row = async () =>
    (
      await check(
        { ...host, doc: (kind: string) => (docs[kind] ? { kind } : undefined) } as never,
        async (doc, id) => docs[(doc as unknown as { kind: string }).kind][id],
      )
    ).find((issue) => issue.area === 'Project memory')
  expect(await row()).toMatchObject({
    status: 'warn',
    summary: 'none in root #1',
    impact: expect.stringContaining('full project context'),
  })
  docs['lineage.memory'][1] = {
    memories: { stack: { kind: 'fact', line: 'TypeScript', body: 'TypeScript.', updated: 0 } },
  }
  expect(await row()).toBeUndefined()
})

it('notes the primary agent only when its warnings change, and once when they clear', async () => {
  const seen = {}
  const tx = { doc: async () => seen } as unknown as Tx
  const id = 7 as ConversationId
  const warn: SetupIssue = { area: 'Secrets', status: 'warn', summary: 'X missing' }
  const info: SetupIssue = { area: 'Tailscale', status: 'info', summary: 'off' }
  const content = async (issues: SetupIssue[]) =>
    (await noteFor(tx, id, issues, 0))?.entries[0].model[0].content
  expect(await content([warn, info])).toContain('- Secrets: X missing')
  expect(await content([warn])).toBeUndefined()
  expect(await content([{ ...warn, summary: 'Y missing' }])).toContain('Y missing')
  expect(await content([info])).toContain('resolved')
  expect(await content([info])).toBeUndefined()
  expect(await noteFor(tx, id, undefined, 0)).toBeUndefined()
})
