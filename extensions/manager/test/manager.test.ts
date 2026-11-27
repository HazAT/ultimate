import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { fauxServer, post, temp, removeTemp } from '../../../test/helpers.ts'
import { context } from '../../../server/harness.ts'
import { git } from '../../../lib/git.ts'
import { projectDecision } from '../../../lib/project-setup.ts'
import { updateSettings } from '../../../lib/settings.ts'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'

async function setupFixture(decision?: boolean) {
  const home = await temp('ultimate-manager-')
  const project = join(home, 'project')
  const config = join(project, '.ultimate')
  const userFile = join(home, '.ultimate/settings.json')
  const projectFile = join(config, 'settings.json')
  await mkdir(join(config, 'extensions/x'), { recursive: true })
  await mkdir(join(config, 'agents'), { recursive: true })
  await mkdir(join(config, 'skills/local-skill'), { recursive: true })
  await writeFile(
    join(config, 'extensions/x/server.ts'),
    "import { defineExtension } from '@earendil-works/pi-durable'; export default defineExtension({ name: 'x' })",
  )
  await writeFile(join(config, 'extensions/x/web.solid.tsx'), 'export default {}')
  await writeFile(
    join(config, 'extensions/x/README.md'),
    '# X\n\nA local extension. Another sentence.',
  )
  await writeFile(
    join(config, 'agents/y.md'),
    '---\nname: y\ndescription: Project agent\n---\nInspect the project.',
  )
  await writeFile(
    join(config, 'skills/local-skill/SKILL.md'),
    '---\nname: local-skill\ndescription: Project skill\n---\nInspect.',
  )
  await writeFile(join(config, 'README.md'), 'Project setup.\n')
  await writeFile(
    projectFile,
    JSON.stringify({
      defaultSurface: 'workbench',
      custom: { keep: 1 },
      extensions: { disable: ['plan'], extra: 'keep' },
    }),
  )
  if (decision !== undefined) new ProjectTrustStore(join(home, '.ultimate')).set(project, decision)
  const options = {
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome: home,
    home: join(home, 'state'),
    localSetup: false,
    firstRun: true,
  }
  return { home, project, projectFile, userFile, options }
}

function drive(server: Awaited<ReturnType<typeof fauxServer>>) {
  return {
    action: async (name: string, args: unknown = {}) => {
      const response = await post(server, `/api/extensions/manager/actions/${name}`, { args })
      expect(response.status).toBe(200)
      return response.data.result
    },
    enabled: (name: string) =>
      server.extensions.info().find((entry) => entry.name === name)?.enabled,
    web: async () => server.web.facets(),
    tools: async () => (await server.root.agent(context)).tools.map((tool) => tool.name),
  }
}

it('gates project resources until the local setup is chosen, and remembers the choice', async () => {
  const { home, project, options } = await setupFixture()
  let server: Awaited<ReturnType<typeof fauxServer>> | undefined
  try {
    server = await fauxServer(options)
    const { action, enabled, web, tools } = drive(server)
    expect(server.system.current().project).toMatchObject({
      config: true,
      decision: null,
      settings: {},
    })
    expect(enabled('x')).toBe(false)
    expect(enabled('plan')).toBe(true)
    expect(await tools()).toContain('plan')
    expect(server.system.current().skills.some((skill) => skill.name === 'local-skill')).toBe(false)
    expect(
      (await action('extensions')).find((entry: { name: string }) => entry.name === 'x'),
    ).toMatchObject({
      source: 'project',
      enabled: false,
      layer: 'folder',
      readme: 'A local extension.',
    })
    // details: the contract summary, catalogue edges and refs events of a loaded extension; tool descriptions in info.
    const log = await action('details', { name: 'messages' })
    expect(log.summary).not.toBe('')
    expect(log.provides).toContain('messages')
    expect(log.needs).toContain('subagents')
    expect(log.events).toEqual(expect.arrayContaining(['board.sent']))
    expect(
      server.extensions.info().find((entry) => entry.name === 'messages')?.server?.tools,
    ).toContainEqual({ name: 'message', description: expect.stringMatching(/\S/) })
    expect(
      (await post(server, '/api/extensions/manager/actions/details', { args: { name: 'nope' } }))
        .data.error,
    ).toContain('Unknown extension "nope"')
    const denied = await post(server, '/api/extensions/manager/actions/setExtension', {
      args: { name: 'splash', enabled: false, scope: 'project' },
    })
    expect(denied.status).toBe(500)
    expect(denied.data.error).toContain('local setup')
    await action('decide', { local: true })
    expect(enabled('x')).toBe(true)
    expect(enabled('plan')).toBe(false)
    expect(await tools()).not.toContain('plan')
    expect((await web()).some((path) => path.endsWith('/x/web.solid.tsx'))).toBe(true)
    expect(server.system.current().skills.some((skill) => skill.name === 'local-skill')).toBe(true)
    expect(projectDecision(project, home)).toBe(true)
    const first = server
    server = undefined
    await first.close()
    server = await fauxServer(options)
    expect(server.system.current().project.decision).toBe(true)
    expect(drive(server).enabled('x')).toBe(true)
  } finally {
    await server?.close()
    await removeTemp(home)
  }
})

it('applies extension choices live at project and user scope, keeping other settings', async () => {
  const { home, projectFile, userFile, options } = await setupFixture(true)
  const server = await fauxServer(options)
  try {
    const { action, enabled, web } = drive(server)
    await action('setExtension', { name: 'splash', enabled: false, scope: 'project' })
    expect(enabled('splash')).toBe(false)
    expect((await web()).some((path) => path.endsWith('/splash/web.solid.tsx'))).toBe(false)
    await action('setExtension', { name: 'splash', enabled: true, scope: 'project' })
    expect(enabled('splash')).toBe(true)
    expect((await web()).some((path) => path.endsWith('/splash/web.solid.tsx'))).toBe(true)
    const projectSettings = JSON.parse(await readFile(projectFile, 'utf8'))
    expect(projectSettings).toMatchObject({
      custom: { keep: 1 },
      defaultSurface: 'workbench',
      extensions: { extra: 'keep', enable: ['splash'], disable: ['plan'] },
    })
    await Promise.all(
      ['info', 'documents'].map((name) =>
        action('setExtension', { name, enabled: true, scope: 'user' }),
      ),
    )
    expect(JSON.parse(await readFile(userFile, 'utf8')).extensions.enable).toEqual(
      expect.arrayContaining(['info', 'documents']),
    )
    await action('setExtension', { name: 'sounds', enabled: false, scope: 'user' })
    expect(JSON.parse(await readFile(userFile, 'utf8'))).toEqual({
      extensions: { enable: expect.arrayContaining(['info', 'documents']), disable: ['sounds'] },
    })
    await writeFile(
      userFile + '.tmp',
      JSON.stringify({ custom: 'user', extensions: { disable: ['sounds'], extra: 2 } }),
    )
    await rename(userFile + '.tmp', userFile)
    await action('setExtension', { name: 'sounds', enabled: true, scope: 'user' })
    expect(enabled('sounds')).toBe(true)
    expect((await web()).some((path) => path.endsWith('/sounds/web.solid.tsx'))).toBe(true)
    await action('setExtension', { name: 'sounds', enabled: false, scope: 'user' })
    expect(enabled('sounds')).toBe(false)
    expect((await web()).some((path) => path.endsWith('/sounds/web.solid.tsx'))).toBe(false)
    expect(JSON.parse(await readFile(userFile, 'utf8'))).toMatchObject({
      custom: 'user',
      extensions: { extra: 2, enable: [], disable: ['sounds'] },
    })
    expect(
      (await action('extensions')).find((entry: { name: string }) => entry.name === 'splash').layer,
    ).toBe('project')
    expect(
      (await action('extensions')).find((entry: { name: string }) => entry.name === 'sounds').layer,
    ).toBe('user')
  } finally {
    await server.close()
    await removeTemp(home)
  }
})

it('withdraws the local setup and adopts it into user settings', async () => {
  const { home, projectFile, userFile, options } = await setupFixture(true)
  await updateSettings(projectFile, (value) => {
    value.extensions = { ...(value.extensions as object), enable: ['splash'] }
  })
  await writeFile(
    userFile,
    JSON.stringify({ custom: 'user', extensions: { extra: 2, disable: ['sounds'] } }),
  )
  let server: Awaited<ReturnType<typeof fauxServer>> | undefined
  try {
    server = await fauxServer(options)
    const { action, enabled, web, tools } = drive(server)
    await action('decide', { local: false })
    expect(enabled('x')).toBe(false)
    expect(enabled('plan')).toBe(true)
    expect(await tools()).toContain('plan')
    expect((await web()).some((path) => path.endsWith('/x/web.solid.tsx'))).toBe(false)
    expect(server.system.current().skills.some((skill) => skill.name === 'local-skill')).toBe(false)
    const adoptDenied = await post(server, '/api/extensions/manager/actions/adoptProjectSetup', {
      args: {},
    })
    expect(adoptDenied.status).toBe(500)
    await action('decide', { local: true })
    await action('adoptProjectSetup')
    await action('decide', { local: false })
    expect(enabled('plan')).toBe(false)
    expect(JSON.parse(await readFile(userFile, 'utf8'))).toMatchObject({
      custom: 'user',
      extensions: { extra: 2, enable: ['splash'], disable: ['sounds', 'plan'] },
    })
    const first = server
    server = undefined
    await first.close()
    server = await fauxServer(options)
    expect(server.system.current().project.decision).toBe(false)
    expect(drive(server).enabled('x')).toBe(false)
  } finally {
    await server?.close()
    await removeTemp(home)
  }
})

it('does not inherit a parent project choice', async () => {
  const home = await temp('ultimate-trust-')
  try {
    const project = join(home, 'parent/child')
    await mkdir(project, { recursive: true })
    new ProjectTrustStore(join(home, '.ultimate')).set(join(home, 'parent'), true)
    expect(projectDecision(project, home)).toBe(null)
  } finally {
    await removeTemp(home)
  }
})

it('shares one choice between a checkout and its linked worktrees', async () => {
  const home = await temp('ultimate-trust-worktree-')
  try {
    const main = join(home, 'main')
    const worktree = join(home, 'worktree')
    await mkdir(join(main, '.ultimate/agents'), { recursive: true })
    await writeFile(join(main, '.ultimate/agents/y.md'), '---\nname: y\ndescription: Y\n---\nY.')
    await git(main, 'init', '-b', 'main')
    await git(main, 'add', '.')
    await git(main, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-m', 'base')
    await git(main, 'worktree', 'add', worktree, '-b', 'branch')
    expect(projectDecision(worktree, home)).toBe(null)
    new ProjectTrustStore(join(home, '.ultimate')).set(main, true)
    expect(projectDecision(worktree, home)).toBe(true)
    // A worktree's own entry is not consulted, and choosing from it decides for the checkout.
    new ProjectTrustStore(join(home, '.ultimate')).set(worktree, false)
    expect(projectDecision(worktree, home)).toBe(true)
    const server = await fauxServer({
      ultimateRoot: resolve('.'),
      projectRoot: worktree,
      userHome: home,
      home: join(home, 'state'),
      localSetup: false,
    })
    try {
      expect(server.system.current().project.decision).toBe(true)
      await post(server, '/api/extensions/manager/actions/decide', { args: { local: false } })
      expect(projectDecision(main, home)).toBe(false)
    } finally {
      await server.close()
    }
  } finally {
    await removeTemp(home)
  }
})

it('boots with corrupt trust, discloses project replacements, and recovers after repair', async () => {
  const home = await temp('ultimate-corrupt-trust-')
  const project = join(home, 'project')
  await mkdir(join(project, '.ultimate/extensions/codemode'), { recursive: true })
  await mkdir(join(home, '.ultimate'), { recursive: true })
  await writeFile(join(home, '.ultimate/trust.json'), '{bad')
  await writeFile(join(project, '.ultimate/README.md'), 'x'.repeat(16383) + '😀')
  let server: Awaited<ReturnType<typeof fauxServer>> | undefined
  try {
    server = await fauxServer({
      ultimateRoot: resolve('.'),
      projectRoot: project,
      userHome: home,
      home: join(home, 'state'),
      localSetup: false,
    })
    expect(server.system.current().project.decision).toBe(null)
    expect(server.system.current().extensionDiagnostics.join(' ')).toContain(
      'Failed to read trust store',
    )
    expect(server.system.current().project.readme).toBe('x'.repeat(16383) + '😀')
    const status = await post(server, '/api/extensions/onboarding/actions/status', { args: {} })
    expect(status.data.result.adds.replaces).toEqual(['codemode'])
    const rows = await post(server, '/api/extensions/manager/actions/extensions', { args: {} })
    expect(rows.data.result.find((row: { name: string }) => row.name === 'codemode')).toMatchObject(
      { source: 'project', replaces: 'builtin', enabled: false },
    )
    await writeFile(join(home, '.ultimate/trust.json'), '{}')
    const choice = await post(server, '/api/extensions/manager/actions/decide', {
      args: { local: true },
    })
    expect(choice.status).toBe(200)
    const userFile = join(home, '.ultimate/settings.json')
    await writeFile(userFile, '{"custom":1}')
    const adopted = await post(server, '/api/extensions/manager/actions/adoptProjectSetup', {
      args: {},
    })
    expect(adopted.status).toBe(200)
    expect(await readFile(userFile, 'utf8')).toBe('{"custom":1}')
    expect(server.system.current().extensionDiagnostics.join(' ')).not.toContain(
      'Failed to read trust store',
    )
  } finally {
    await server?.close()
    await removeTemp(home)
  }
})
