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

export const MOVES =
  /^((state|trace|state\.stale-.+)\.sqlite(-wal|-shm)?|chapters|chapters\.json|pending-chapter\.json|conversations\.json|previews\.json|supervisor\.log)$/
export const JOURNAL = 'reset.json'

type ReplayableInstallation = { database: string; record: BackupFile }

export interface Journal {
  backup: string
  restore?: ReplayableInstallation
}

export const readJournal = (home: string) =>
  readJson<Journal | undefined>(join(home, JOURNAL), undefined)

const SUPERVISOR_AND_STORAGE_LOCKS = ['ultimate.lock', 'storage.lock']

export interface Plan {
  home: string
  backup: string
  moves: string[]
  resumes: boolean
  running?: { pid: number; port?: number }
}

async function inventory(home: string) {
  const journal = await readJournal(home)
  if (journal?.restore)
    throw new Error(`A restore into ${home} was interrupted; finish it with pnpm restore first`)
  return { journal, moves: await movable(home) }
}

export const movable = async (home: string) =>
  (await readdir(home)).filter((name) => MOVES.test(name)).toSorted()

export const backupFolder = (backups: string, kind: string, home: string, now = new Date()) =>
  join(backups, `${kind}-${now.toISOString().replace(/[:.]/g, '-')}`, home.split('/').at(-1)!)

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

export async function holder(home: string) {
  for (const name of SUPERVISOR_AND_STORAGE_LOCKS) {
    const lock = join(home, name)
    const running = await readOwner(lock)
    if (!running) continue
    const staleSidecarProbe = await acquireLock(lock, { pid: process.pid }).catch(meansNone)
    if (!staleSidecarProbe) return { running }
    await staleSidecarProbe.close()
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

export async function lockHome(home: string, command?: string) {
  const held: Awaited<ReturnType<typeof acquireLock>>[] = []
  const close = async () => {
    for (const lock of held.toReversed()) await lock.close()
  }
  try {
    for (const name of SUPERVISOR_AND_STORAGE_LOCKS) {
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

export async function moveInto(home: string, backup: string, names: string[]) {
  await mkdir(backup, { recursive: true })
  for (const name of names) {
    const to = join(backup, name)
    if (existsSync(to)) throw new Error(`${to} already exists; refusing to overwrite the backup`)
    await rename(join(home, name), to)
  }
}

const journalBeforeMoves = (home: string, journal: Journal) =>
  writeJson(join(home, JOURNAL), journal)
const removeJournalLast = (home: string) => rm(join(home, JOURNAL))

export async function apply(p: Plan) {
  const lock = await lockHome(p.home)
  try {
    const { journal: existingResetIntent, moves: stateRecheckedUnderLock } = await inventory(p.home)
    const backup = existingResetIntent?.backup ?? p.backup
    await mkdir(backup, { recursive: true })
    if (!existingResetIntent) await journalBeforeMoves(p.home, { backup } satisfies Journal)
    await moveInto(p.home, backup, stateRecheckedUnderLock)
    await removeJournalLast(p.home)
    return { backup }
  } finally {
    await lock.close()
  }
}

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
