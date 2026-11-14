// Install a project's cloud backup as its state on this machine: the current state moves into a backup folder first.
// Usage: pnpm restore [name|key] [--snapshot <id>] [--chapter <name>] [--dir <project dir>] [--yes] [--dry-run].
// See "Cloud backups" in extensions/cloud/README.md.
import { existsSync } from 'node:fs'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { cloudConfig, fetchRegister } from '../lib/cloud.ts'
import type { Register } from '../lib/cloud.ts'
import { moveDatabase } from '../lib/database-files.ts'
import { projectIdentity } from '../lib/project-identity.ts'
import { readSecret } from '../lib/secrets.ts'
import { projectHome } from '../lib/project-paths.ts'
import { writeJson } from '../lib/json-file.ts'
import { chapterKey, writeBackup } from '../extensions/cloud/backup.ts'
import {
  chapterFiles,
  chapterName,
  CHAPTERS_FILE,
  continueChapterIds,
  FIRST_CHAPTER,
  PENDING_CHAPTER,
  readChapters,
} from '../lib/chapters.ts'
import { downloadSnapshot } from '../extensions/cloud/snapshot.ts'
import type { Journal } from './reset.ts'
import {
  backupFolder,
  holder,
  JOURNAL,
  lockHome,
  movable,
  moveInto,
  readJournal,
  refusal,
  size,
} from './reset.ts'

const SNAPSHOT_KEY = 'ULTIMATE_CLOUD_SNAPSHOT_KEY'
const USAGE =
  'Usage: pnpm restore [name|key] [--snapshot <id>] [--chapter <name>] [--dir <project dir>] [--yes] [--dry-run]'

/** The register's project named `query` (its name or key, case-insensitively), or the one with key `key`. */
export function findProject(
  register: Register,
  query: string | undefined,
  key: string | undefined,
  chapter = FIRST_CHAPTER,
) {
  const wanted = (query ?? key)?.toLowerCase()
  const suffix = chapter === FIRST_CHAPTER ? '' : `@${chapter}`
  const matches = register.projects.filter((project) => {
    if (suffix ? !project.key.endsWith(suffix) : project.key.includes('@')) return false
    return [
      project.name,
      suffix ? project.key.slice(0, -suffix.length) : project.key,
      project.key,
    ].some((value) => value.toLowerCase() === wanted)
  })
  if (matches.length > 1)
    throw new Error(
      `${query} names ${matches.length} projects in the cloud: ${matches.map((project) => project.key).join(', ')}; use its key`,
    )
  if (!matches[0])
    throw new Error(
      `No backup of ${query ?? key} in the cloud. Backed up: ${register.projects.map((project) => project.name).join(', ') || 'none'}`,
    )
  return matches[0]
}

export interface RestoreOptions {
  url: string
  token: string
  secret: string
  key: string
  id: string
  /** The project's Ultimate home, created when missing. */
  home: string
  /** Omitted selects the home's active chapter. */
  chapter?: string
  /** The project's checkout, which receives the backup's `ultimate/*` branches. */
  projectRoot: string
  /** `~/.ultimate/backups`. */
  backups: string
  now?: Date
}

/** What a restore of the chapter in `dir` moves aside: its state files, never other chapters. */
const chapterState = async (dir: string) =>
  (await movable(dir)).filter(
    (name) => !/^(chapters|chapters\.json|pending-chapter\.json)$/.test(name),
  )

/** The home-wide journal still blocks every chapter until installation and registration finish. */
type RestoreJournal = Journal & { chapter?: string }

/** Both locks of `home`, held for `step`; refused while an Ultimate runs there. */
async function locked<T>(home: string, step: () => Promise<T>) {
  const lock = await lockHome(home, 'pnpm restore')
  try {
    return await step()
  } finally {
    await lock.close()
  }
}

/**
 * Download and verify backup `id`, then, holding the home's locks (refused while Ultimate runs there), journal the
 * restore, move the home's state into `<backups>/restore-<time>/<home>/`, install the backup as `state.sqlite` and
 * record it as the parent of the next backup. Nothing in the home moves until the download verified; a snapshot taken
 * of a checkout at another path is refused.
 */
export async function restore(o: RestoreOptions) {
  await mkdir(o.home, { recursive: true })
  return locked(o.home, async () => {
    const pending = await readJournal(o.home)
    if (pending)
      throw new Error(
        pending.restore
          ? `A restore into ${o.home} was interrupted; run pnpm restore again to finish it`
          : `A reset of ${o.home} was interrupted; finish it with pnpm reset first`,
      )
    if (existsSync(join(o.home, PENDING_CHAPTER)))
      throw new Error(
        `A chapter switch is pending in ${o.home}; start Ultimate once to finish it, then restore`,
      )
    const chapter = chapterName(o.chapter ?? (await readChapters(o.home)).active)
    const files = chapterFiles(o.home, chapter)
    await mkdir(files.dir, { recursive: true })
    const { database, manifest, keptRefs } = await downloadSnapshot({
      url: o.url,
      token: o.token,
      secret: o.secret,
      key: o.key,
      id: o.id,
      dir: files.dir,
      repo: o.projectRoot,
      root: o.projectRoot,
    })
    const journal: RestoreJournal = {
      ...(chapter !== FIRST_CHAPTER && { chapter }),
      backup: backupFolder(o.backups, 'restore', files.dir, o.now),
      restore: {
        database,
        record: {
          key: o.key,
          parent: manifest.id,
          last: {
            id: manifest.id,
            at: manifest.createdAt,
            machine: manifest.machine,
            bytes: manifest.database.bytes + (manifest.bundle?.bytes ?? 0),
            uploaded: (manifest.database.uploaded ?? 0) + (manifest.bundle?.uploaded ?? 0),
          },
        },
      },
    }
    try {
      await writeJson(join(o.home, JOURNAL), journal)
    } catch (error) {
      // Without a journal nothing moved: the download is the only trace, and it goes.
      await rm(database, { force: true })
      throw error
    }
    return { ...(await install(o.home, journal)), manifest, keptRefs }
  })
}

/**
 * Carry out a journaled restore; each step can be repeated. Until the download is installed, the home's state (and
 * its `cloud-backup.json`) moves to the backup; then the download becomes `state.sqlite`, the record is written, and
 * the journal goes last. An interruption leaves the journal, which keeps Ultimate from opening the home.
 */
async function install(home: string, journal: RestoreJournal) {
  const { backup, restore: pending } = journal
  const chapter = journal.chapter ?? FIRST_CHAPTER
  const { dir, database } = chapterFiles(home, chapter)
  if (!pending) throw new Error(`${join(home, JOURNAL)} is a reset's; finish it with pnpm reset`)
  const moves: string[] = []
  if (existsSync(pending.database)) {
    // Only this chapter's state moves: the other chapters and their record stay.
    moves.push(...(await chapterState(dir)))
    if (existsSync(join(dir, 'cloud-backup.json'))) moves.push('cloud-backup.json')
    await moveInto(dir, backup, moves)
    await moveDatabase(pending.database, database)
  } else if (!existsSync(database))
    throw new Error(
      `${pending.database} is gone and ${dir} has no state.sqlite; the restore cannot finish`,
    )
  await writeBackup(dir, pending.record)
  // The restored chapter becomes active; a home that only ever had the first chapter keeps no chapters file.
  if (chapter !== FIRST_CHAPTER || existsSync(join(home, CHAPTERS_FILE))) {
    const chapters = await readChapters(home)
    if (!chapters.chapters.some(({ name }) => name === chapter))
      chapters.chapters.push({ name: chapter, createdAt: Date.now() })
    chapters.active = chapter
    await writeJson(join(home, CHAPTERS_FILE), chapters)
  }
  // The backup may predate conversations of the chapters kept here: ids continue after theirs.
  await continueChapterIds(home, chapter)
  await rm(join(home, JOURNAL))
  return { backup, moves, dir, database }
}

/** Finish the restore an interrupted `pnpm restore` journaled in `home`, into the same backup folder. */
export const finishRestore = (home: string) =>
  locked(home, async () => {
    const journal: RestoreJournal | undefined = await readJournal(home)
    if (!journal?.restore) throw new Error(`No interrupted restore in ${home}`)
    return { ...(await install(home, journal)), record: journal.restore.record }
  })

/** `pnpm restore` with `args`; exported for tests, which point HOME and the cloud variables at scratch values. */
export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    options: {
      snapshot: { type: 'string' },
      chapter: { type: 'string' },
      dir: { type: 'string' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean' },
    },
    allowPositionals: true,
    args,
  })
  if (positionals.length > 1) throw new Error(USAGE)
  const [query] = positionals
  const user = homedir()
  const dir = await realpath(values.dir ?? process.env.INIT_CWD ?? process.cwd())
  const home = process.env.ULTIMATE_HOME || projectHome(dir, user)
  const backups = join(user, '.ultimate', 'backups')
  if (existsSync(home) && (await readJournal(home))?.restore) {
    console.log(`Finishing an interrupted restore into ${home}.`)
    if (values['dry-run']) return
    const done = await finishRestore(home)
    console.log(`\nInstalled backup ${done.record.parent} as ${done.database}.`)
    return undo(done.backup, done.dir)
  }
  const identity = await projectIdentity(dir)
  if (!identity)
    throw new Error(`${dir} has no GitHub origin remote; pass --dir <project checkout>`)
  const cloud = await cloudConfig({
    userHome: user,
    notice: (message) => {
      throw new Error(message)
    },
  })
  if (!cloud)
    throw new Error('Cloud backups are off: set cloud.url (⌘K → Join cloud backups) and try again.')
  const secret = process.env[SNAPSHOT_KEY] ?? (await readSecret(user, SNAPSHOT_KEY))
  if (!secret)
    throw new Error(`Missing ${SNAPSHOT_KEY}. Add it in the Secrets panel (⌘K → Secrets).`)
  const chapter = chapterName(
    values.chapter ??
      (query?.includes('@')
        ? query.slice(query.lastIndexOf('@') + 1)
        : (await readChapters(home)).active),
  )
  const files = chapterFiles(home, chapter)
  const key = chapterKey(identity.key, chapter, chapter === FIRST_CHAPTER)
  // A named snapshot needs no register: its project is this checkout's, and older backups predate the register.
  const project = values.snapshot
    ? { key, name: basename(dir), latest: undefined }
    : findProject(await fetchRegister(cloud), query, identity.key, chapter)
  if (
    values.snapshot &&
    query &&
    ![identity.key, project.key, project.name.toLowerCase()].includes(query.toLowerCase())
  )
    throw new Error(`${dir} is a checkout of ${identity.key}, not ${query}; pass --dir <checkout>`)
  if (project.key !== key)
    throw new Error(
      `${dir} is a checkout of ${identity.key}, not ${project.key}; pass --dir <checkout of ${project.name}>`,
    )
  const latest = project.latest
  const id = values.snapshot ?? latest!.id
  console.log(
    `Restore ${project.name} (${project.key})\n  home     ${home}\n  snapshot ${id}` +
      (id === latest?.id
        ? ` (latest, from ${latest.machine} at ${new Date(latest.at).toISOString()})`
        : '') +
      '\n',
  )
  const moves = existsSync(files.dir) ? await chapterState(files.dir) : []
  for (const name of moves) console.log(`  move ${name} (${await size(join(files.dir, name))})`)
  if (!moves.length) console.log('  nothing to move: the home holds no state yet')
  const { running } = existsSync(home) ? await holder(home) : {}
  if (running) {
    if (!values['dry-run']) throw refusal(running, 'pnpm restore')
    console.log(`\n${refusal(running, 'pnpm restore').message}`)
  }
  if (values['dry-run']) return
  if (!values.yes) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await prompt.question('\nRestore? [y/N] ')
    prompt.close()
    if (!/^y(es)?$/i.test(answer.trim())) return console.log('Nothing changed.')
  }
  const done = await restore({
    ...cloud,
    secret,
    key: project.key,
    id,
    home,
    chapter,
    projectRoot: dir,
    backups,
  })
  console.log(
    `\nInstalled backup ${id} (${done.manifest.machine}, ${new Date(done.manifest.createdAt).toISOString()}) as ${done.database}.`,
  )
  console.log(`The next backup from here builds on ${id}.`)
  if (!done.manifest.root)
    console.log(
      `Warning: this backup predates recorded paths; if it was taken from a checkout other than ${dir}, its conversations and worktrees point there.`,
    )
  if (done.keptRefs.length)
    console.log(`Branches that differ here were kept aside:\n  ${done.keptRefs.join('\n  ')}`)
  if (done.moves.length) undo(done.backup, done.dir)
}

const undo = (backup: string, home: string) =>
  console.log(
    `The previous state is in ${backup}.\nTo undo: stop Ultimate, then\n  mv ${join(backup, '*')} ${home}/\n`,
  )

if (import.meta.main)
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
