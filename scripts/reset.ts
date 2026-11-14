// Start a project's Ultimate from a fresh state: its conversation state moves into a backup folder, nothing is deleted.
// Usage: pnpm reset [dir] [--dry-run] [--yes]. See "Starting fresh" in docs/running.md.
import { existsSync } from 'node:fs'
import { mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { git } from '../lib/git.ts'
import { meansNone } from '../lib/errors.ts'
import { readJson, writeJson } from '../lib/json-file.ts'
import { acquireLock, readOwner } from '../lib/lock.ts'
import { projectHome } from '../lib/project-paths.ts'
import type { BackupFile } from '../extensions/cloud/backup.ts'

/**
 * Files that go: the state, the call trace and states parked by earlier versions, each with its `-wal` and `-shm` (also
 * one whose database already went, as an interrupted reset leaves it), later chapters with their record and a pending
 * switch, and files describing the old state, rebuilt when needed.
 */
export const MOVES =
  /^((state|trace|state\.stale-.+)\.sqlite(-wal|-shm)?|chapters|chapters\.json|pending-chapter\.json|conversations\.json|previews\.json|supervisor\.log)$/
/**
 * The reset or restore in progress, written before the first file moves: a rerun finishes it into the same backup.
 * While it exists no Ultimate opens the home (`server/harness.ts`).
 */
export const JOURNAL = 'reset.json'

export interface Journal {
  backup: string
  /** A restore's: the downloaded database in the home, installed last, and the `cloud-backup.json` it gets. */
  restore?: { database: string; record: BackupFile }
}

export const readJournal = (home: string) =>
  readJson<Journal | undefined>(join(home, JOURNAL), undefined)

/** The locks a running Ultimate holds: the supervisor's, and storage's, which a standalone `server/main.ts` takes. */
const LOCKS = ['ultimate.lock', 'storage.lock']

export interface Plan {
  home: string
  backup: string
  /** Names in the home that move to the backup. */
  moves: string[]
  /** An interrupted reset this one finishes. */
  resumes: boolean
  /** The Ultimate running in this home; `apply` refuses while it runs. */
  running?: { pid: number; port?: number }
}

/** What a reset of `home` moves now. `apply` asks again under the home's lock. */
async function inventory(home: string) {
  const journal = await readJournal(home)
  if (journal?.restore)
    throw new Error(`A restore into ${home} was interrupted; finish it with pnpm restore first`)
  return { journal, moves: await movable(home) }
}

/** The names in `home` that hold its state, sorted. */
export const movable = async (home: string) =>
  (await readdir(home)).filter((name) => MOVES.test(name)).toSorted()

/** `<backups>/<kind>-<time>/<home's folder>`: where a reset or restore keeps the state it replaces. */
export const backupFolder = (backups: string, kind: string, home: string, now = new Date()) =>
  join(backups, `${kind}-${now.toISOString().replace(/[:.]/g, '-')}`, home.split('/').at(-1)!)

/** What a reset of `home` moves. */
export async function plan(home: string, backups: string, now = new Date()): Promise<Plan> {
  if (!existsSync(home)) throw new Error(`No Ultimate home at ${home}`)
  const { journal, moves } = await inventory(home)
  return {
    home,
    backup: journal?.backup ?? backupFolder(backups, 'reset', home, now),
    moves,
    resumes: !!journal,
    ...(await holder(home)),
  }
}

/** The Ultimate that holds one of `home`'s locks; a sidecar a crashed process left is no owner. */
export async function holder(home: string) {
  for (const name of LOCKS) {
    const lock = join(home, name)
    const running = await readOwner(lock)
    if (!running) continue
    const probe = await acquireLock(lock, { pid: process.pid }).catch(meansNone)
    if (!probe) return { running }
    await probe.close()
  }
  return {}
}

export const refusal = (owner: { pid: number; port?: number }, command = 'pnpm reset') =>
  new Error(
    `Ultimate is running here (pid ${owner.pid}${owner.port ? `, http://127.0.0.1:${owner.port}` : ''}). Stop it first:\n` +
      `  systemctl --user stop ultimate        # the project service\n` +
      `  launchctl bootout gui/$(id -u)/com.ultimate.app   # on macOS\n` +
      `or Ctrl+C the terminal running it, then run ${command} again.`,
  )

/**
 * Hold `home`'s locks, the supervisor's and storage's, so no Ultimate starts or opens the state meanwhile; refuses
 * while one runs. Close the returned lock.
 */
export async function lockHome(home: string, command?: string) {
  const held: Awaited<ReturnType<typeof acquireLock>>[] = []
  const close = async () => {
    for (const lock of held.toReversed()) await lock.close()
  }
  try {
    for (const name of LOCKS) {
      const path = join(home, name)
      held.push(
        await acquireLock(path, { pid: process.pid }).catch(async () => {
          throw refusal((await readOwner(path)) ?? { pid: 0 }, command)
        }),
      )
    }
  } catch (error) {
    await close()
    throw error
  }
  return { close }
}

/** Move `names` from `home` into `backup`, never overwriting a file already there. */
export async function moveInto(home: string, backup: string, names: string[]) {
  await mkdir(backup, { recursive: true })
  for (const name of names) {
    const to = join(backup, name)
    if (existsSync(to)) throw new Error(`${to} already exists; refusing to overwrite the backup`)
    await rename(join(home, name), to)
  }
}

/**
 * Move the files into the plan's backup folder, holding the home's lock so Ultimate cannot start meanwhile. Each
 * step can be repeated: an interrupted reset leaves its journal, and running it again finishes it.
 */
export async function apply(p: Plan) {
  const lock = await lockHome(p.home)
  try {
    const { journal, moves } = await inventory(p.home)
    const backup = journal?.backup ?? p.backup
    await mkdir(backup, { recursive: true })
    if (!journal) await writeJson(join(p.home, JOURNAL), { backup } satisfies Journal)
    await moveInto(p.home, backup, moves)
    await rm(join(p.home, JOURNAL))
    return { backup }
  } finally {
    await lock.close()
  }
}

/** Worktrees with uncommitted changes and `ultimate/*` branches not merged into HEAD: work the reset leaves in place. */
async function unlanded(home: string, project: string) {
  const dirty: string[] = []
  const worktrees = join(home, 'worktrees')
  if (existsSync(worktrees))
    for (const name of await readdir(worktrees)) {
      const path = join(worktrees, name)
      const status = await git(path, 'status', '--porcelain').catch(() => '')
      if (status) dirty.push(path)
    }
  const branches = (
    await git(
      project,
      'branch',
      '--no-merged',
      'HEAD',
      '--format=%(refname:short)',
      'ultimate/*',
    ).catch(() => '')
  )
    .split('\n')
    .filter(Boolean)
  return { dirty, branches }
}

export async function size(path: string) {
  const bytes = (await stat(path)).size
  return bytes > 1024 ** 2
    ? `${(bytes / 1024 ** 2).toFixed(0)} MB`
    : `${Math.ceil(bytes / 1024)} KB`
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean' },
    },
    allowPositionals: true,
  })
  if (positionals.length > 1) throw new Error('Usage: pnpm reset [dir] [--dry-run] [--yes]')
  const user = homedir()
  const project = await realpath(positionals[0] ?? process.env.INIT_CWD ?? process.cwd())
  const home = process.env.ULTIMATE_HOME || projectHome(project, user)
  const p = await plan(home, join(user, '.ultimate', 'backups'))
  const work = await unlanded(home, project)

  console.log(`Reset ${project}\n  home   ${home}\n  backup ${p.backup}\n`)
  if (p.resumes) console.log('Finishing an interrupted reset into the same backup.')
  else if (!p.moves.length) console.log('Nothing to move: the home is already fresh.')
  for (const name of p.moves) console.log(`  move ${name} (${await size(join(home, name))})`)
  console.log(
    '\nKept: settings, secrets, logins, project.json, the lander checkout, worktrees and ultimate/* branches.',
  )
  if (work.dirty.length)
    console.log(`Worktrees with uncommitted changes:\n  ${work.dirty.join('\n  ')}`)
  if (work.branches.length)
    console.log(`Branches not merged into ${project}'s HEAD:\n  ${work.branches.join('\n  ')}`)
  if (p.running) {
    if (!values['dry-run']) throw refusal(p.running)
    console.log(`\n${refusal(p.running).message}`)
  }
  if (values['dry-run'] || (!p.moves.length && !p.resumes)) return

  if (!values.yes) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await prompt.question('\nReset? [y/N] ')
    prompt.close()
    if (!/^y(es)?$/i.test(answer.trim())) return console.log('Nothing changed.')
  }
  const { backup } = await apply(p)
  console.log(`\nMoved to ${backup}.`)
  console.log(`To restore: stop Ultimate, then\n  mv ${join(backup, '*')} ${home}/\n`)
}

if (import.meta.main)
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
