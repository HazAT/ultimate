import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { JsonValue } from '@earendil-works/chord'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'

export default defineExtension({ name: 'project-switch' })

type Project = { path: string; name: string; openedAt?: number }

const isDir = (path: string) =>
  stat(path).then(
    (info) => info.isDirectory(),
    // A missing or unreadable path is simply not a project folder.
    () => false,
  )

/** Folders opened as projects before that still exist, newest first. */
async function opened(ctx: ActionContext) {
  const found = await Promise.all(
    (await ctx.host.projects()).map(async ({ root, openedAt }) =>
      root && (await isDir(root))
        ? { path: root, name: basename(root), ...(openedAt ? { openedAt } : {}) }
        : undefined,
    ),
  )
  return found
    .filter((project): project is Project => project !== undefined)
    .toSorted((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0))
}

/** Git repositories directly under the user's home folder. */
async function repos(home: string) {
  const entries = await readdir(home, { withFileTypes: true })
  const found = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(async (entry) => {
        const path = join(home, entry.name)
        const git = await stat(join(path, '.git')).then(
          () => true,
          // No .git: not a repository.
          () => false,
        )
        return git ? { path, name: entry.name } : undefined
      }),
  )
  return found
    .filter((project): project is Project => project !== undefined)
    .toSorted((a, b) => a.name.localeCompare(b.name))
}

export const actions = {
  /** No arguments → the current project, projects opened before, and git repos under the home folder. */
  async list(_args: JsonValue, ctx: ActionContext) {
    const home = ctx.host.userHome
    const before = await opened(ctx)
    const known = new Set(before.map((project) => project.path))
    return {
      current: ctx.host.projectRoot,
      home,
      opened: before,
      repos: (await repos(home)).filter((project) => !known.has(project.path)),
    }
  },

  /** `{ path }`, an existing absolute folder → records it as the project and restarts the service into it. */
  async open(args: JsonValue, ctx: ActionContext) {
    const raw = (args as { path?: unknown } | null)?.path
    if (typeof raw !== 'string' || !isAbsolute(raw) || raw.includes('\n'))
      throw new Error('Give an absolute folder path')
    const path = resolve(raw)
    if (!(await isDir(path))) throw new Error(`${path} is not an existing folder`)
    const file = join(ctx.host.userHome, '.ultimate', 'current-project')
    const previous = await readFile(file, 'utf8').catch(
      // No file yet: the service falls back to Ultimate's own repo.
      () => undefined,
    )
    await writeFile(file, `${path}\n`)
    try {
      // A transient timer outside ultimate.service restarts it a moment later, so this reply reaches the
      // browser and the restart survives the service stopping its own process tree.
      await ctx.exec('sudo', [
        '-n',
        'systemd-run',
        '--quiet',
        '--collect',
        '--on-active=1',
        '--timer-property=AccuracySec=100ms',
        '/usr/bin/systemctl',
        'restart',
        'ultimate',
      ])
    } catch (error) {
      await (previous === undefined ? rm(file, { force: true }) : writeFile(file, previous))
      throw error
    }
    return { path }
  },
}

// Restarting the service ends every conversation's run: only the user picks it, never an agent.
export const userActions = ['open']
