import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { context, prepareHarness } from '../../server/harness.ts'
import { Metadata } from '../../server/metadata.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import workspaceExtension from '../../extensions/workspaces/server.ts'
import { workspaces } from '../../extensions/workspaces/workspaces.ts'
import { git } from '../../lib/git.ts'
import { temp, until } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
async function repository() {
  const directory = await temp('ultimate-workspaces-')
  const projectRoot = join(directory, 'project')
  await mkdir(projectRoot)
  await git(projectRoot, 'init', '-b', 'main')
  await git(projectRoot, 'config', 'user.email', 'test@example.com')
  await git(projectRoot, 'config', 'user.name', 'Test')
  await writeFile(join(projectRoot, 'base.txt'), 'base')
  await git(projectRoot, 'add', '.')
  await git(projectRoot, 'commit', '-m', 'base')
  return { directory, projectRoot, home: join(directory, 'state') }
}
/** Open the workspaces extension on `paths` in this process, as the server does after a crash. */
async function reopen(paths: Awaited<ReturnType<typeof repository>>, commands: string[]) {
  const prepared = await prepareHarness({
    ...paths,
    userHome: paths.directory,
    ultimateRoot: paths.projectRoot,
  })
  let opened: Awaited<ReturnType<typeof prepared.open>>
  const resources = new Map<string, unknown>()
  const closers: (() => Promise<void>)[] = []
  const host = {
    ...prepared,
    harness: () => opened.harness,
    metadata: Metadata,
    implement: () => {},
    need: () => ({}),
    want: () => undefined,
    projectSettings: async () => ({ isolates: { worktree: { setup: commands } } }),
    extensions: () => [{ name: 'workspaces', enabled: true }],
    resource<T>(key: string, create: () => T): T {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
    onOpen: () => {},
    onClose: (close: () => Promise<void>) => closers.push(close),
  } as unknown as ExtensionHost
  prepared.registry.install(workspaceExtension(host))
  opened = await prepared.open()
  cleanup.push(async () => {
    for (const close of closers) await close()
    await opened.close()
  })
  return workspaces(host)
}
it.each(['symlinked home mid-setup', 'branch creation before registration'])(
  'resumes preparation after a process crash: %s',
  async (scenario) => {
    const paths = await repository()
    const physicalHome = join(paths.directory, 'physical-state')
    await mkdir(physicalHome)
    await symlink(physicalHome, paths.home)
    const started = join(paths.directory, 'started')
    const gate = join(paths.directory, 'gate')
    const idFile = join(paths.directory, 'id')
    const commands = [`echo attempt >> '${started}'; while [ ! -f '${gate}' ]; do sleep 0.05; done`]
    const script = `
    import { writeFile } from 'node:fs/promises';
    import { prepareHarness, context } from './server/harness.ts';
    import extension, { actions } from './extensions/workspaces/server.ts';
    const paths = ${JSON.stringify(paths)};
    const prepared = await prepareHarness({ ...paths, ultimateRoot: paths.projectRoot, userHome: paths.directory });
    let opened;
    const resources = new Map();
    const host = { ...prepared, harness: () => opened.harness, metadata: (await import('./server/metadata.ts')).Metadata,
      projectSettings: async () => ({ isolates: { worktree: { setup: ${JSON.stringify(commands)} } } }),
      extensions: () => [{ name: 'workspaces', enabled: true }],
      implement: () => {}, need: () => ({}), want: () => undefined,
      resource: (key, create) => { if (!resources.has(key)) resources.set(key, create()); return resources.get(key) },
      onOpen: () => {}, onClose: () => {} };
    prepared.registry.install(extension(host));
    opened = await prepared.open();
    await writeFile(${JSON.stringify(idFile)}, String((await actions.create({}, { host })).id));
    setInterval(() => {}, 1000);
  `
    const bin = join(paths.directory, 'bin')
    await mkdir(bin)
    await writeFile(
      join(bin, 'git'),
      `#!/bin/sh
if [ "$1 $2" = "worktree add" ]; then
  # worktree add --no-checkout -b <branch> <path> <base>
  /usr/bin/git branch "$5" "$7" || exit 1
  echo branch > '${started}'
  while [ ! -f '${gate}' ]; do sleep 0.05; done
fi
exec /usr/bin/git "$@"
`,
      { mode: 0o755 },
    )
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(scenario === 'branch creation before registration'
          ? { PATH: `${bin}:${process.env.PATH}` }
          : {}),
      },
    })
    let output = ''
    child.stderr.on('data', (data) => {
      output += data.toString()
    })
    try {
      await until(async () => {
        if (child.exitCode !== null) throw new Error(output)
        return readFile(started, 'utf8').then(
          () => true,
          () => false,
        )
      })
      child.kill('SIGKILL')
      await once(child, 'exit')
      const id = Number(await readFile(idFile, 'utf8')) as ConversationId
      await writeFile(gate, '')
      const service = await reopen(paths, commands)
      await service.ready(id, context)
      const workspace = (await service.get(id, context))!
      expect(workspace.state).toBe('ready')
      expect(workspace.path).toBe(join(await realpath(physicalHome), 'worktrees', String(id)))
      expect((await readFile(started, 'utf8')).trim().split('\n')).toHaveLength(2)
      expect(await git(workspace.path, 'branch', '--show-current')).toBe(workspace.branch)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await once(child, 'exit')
      }
    }
  },
)
