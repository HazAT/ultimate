import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
// Cloud backups and `pnpm restore` against an in-memory Worker (`cloud-stub.ts`): the parent rule, force, and the
// restore that installs a backup as a home's state.
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { backUp, backupPath, classify, Conflict, readBackup } from '../backup.ts'
import { BackupEvent } from '../refs.ts'
import { uploadSnapshot } from '../snapshot.ts'
import { git } from '../../../lib/git.ts'
import { chapterFiles, FIRST_CHAPTER, readChapters, requestChapter } from '../../../lib/chapters.ts'
import { context, prepareHarness } from '../../../server/harness.ts'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { acquireLock } from '../../../server/lock.ts'
import { findProject, main, restore } from '../../../scripts/restore.ts'
import { cloudStub } from './cloud-stub.ts'
import { eventHost, fauxServer, post, temp } from '../../../test/helpers.ts'

const key = 'github.com/o/app'
const stub = cloudStub()
const cloud = { url: 'ws://127.0.0.1:8787', token: 'dev', secret: 'snapshot secret' }

beforeAll(() => vi.stubGlobal('fetch', stub.fetch))
afterAll(() => vi.unstubAllGlobals())

/** A project checkout named `app` and its home: a Pi store, as every backup is, holding `notes` rows. */
async function machine(notes: string[]) {
  const projectRoot = join(await temp('ultimate-backup-project-'), 'app')
  await git(await temp(), 'init', '-q', '-b', 'main', projectRoot)
  const home = await temp('ultimate-backup-home-')
  await (await openNodeSqliteStorage(join(home, 'state.sqlite'))).close(context)
  const db = new DatabaseSync(join(home, 'state.sqlite'))
  db.exec('CREATE TABLE notes (body TEXT)')
  for (const note of notes) db.prepare('INSERT INTO notes VALUES (?)').run(note)
  db.close()
  return { projectRoot, home }
}
const notes = (home: string) => {
  const db = new DatabaseSync(join(home, 'state.sqlite'), { readOnly: true })
  try {
    return db
      .prepare('SELECT body FROM notes')
      .all()
      .map((row) => row.body)
  } finally {
    db.close()
  }
}
/** The first chapter, whose key has no `@` suffix; the commit still names it. */
const firstChapter = { name: FIRST_CHAPTER, number: 1 }
const back = (
  at: { projectRoot: string; home: string },
  name: string,
  extra: { force?: boolean; tailnet?: string; key?: string; fetch?: typeof fetch } = {},
) =>
  backUp({
    ...cloud,
    key,
    chapter: firstChapter,
    machine: name,
    dir: at.home,
    projectRoot: at.projectRoot,
    ...extra,
  })
/** A project of its own for each test, so earlier backups never make its first one stale. */
let projects = 0
const own = () => `github.com/o/other-${++projects}`

it('commits backups with their parent, refuses a stale one with the Worker’s sentence, and sends force', async () => {
  const a = await machine(['from a'])
  const first = await back(a, 'desk', { tailnet: 'https://desk.tail.ts.net' })
  expect(stub.commits.at(-1)).toMatchObject({
    key,
    name: 'app',
    chapter: { name: 'the-beginning', number: 1 },
    machine: 'desk',
    parent: null,
    tailnet: 'https://desk.tail.ts.net',
  })
  expect(stub.commits.at(-1)).not.toHaveProperty('force')
  // 200 records the new backup as the next one's parent.
  expect(await readBackup(a.home, key)).toEqual({ key, parent: first.id, last: first })
  expect(stub.register.projects).toMatchObject([{ key, name: 'app', latest: { id: first.id } }])

  // Another machine restored A's backup and backed up on top of it.
  const b = await machine([])
  await restore({
    ...cloud,
    key,
    id: first.id,
    home: b.home,
    projectRoot: a.projectRoot,
    backups: await temp(),
  })
  expect(notes(b.home)).toEqual(['from a'])
  const second = await back(b, 'laptop')
  expect(stub.commits.at(-1)).toMatchObject({ machine: 'laptop', parent: first.id })

  // A builds on its own, now stale, parent: 409 keeps that parent and carries the Worker's sentence.
  const before = await readFile(backupPath(a.home), 'utf8')
  const refused = await back(a, 'desk').catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(Conflict)
  expect((refused as Conflict).message).toBe(
    'laptop backed up app after this machine last did; restore its backup or back up anyway to replace it',
  )
  expect((refused as Conflict).latest).toEqual({
    id: second.id,
    machine: 'laptop',
    at: second.at,
  })
  expect(classify(refused)).toBe('conflict')
  expect(await readFile(backupPath(a.home), 'utf8')).toBe(before)
  // The refused upload's chunks stay for the Worker's retention.
  const uploaded = new Set([...stub.objects.keys()].map((name) => name.split('/')[1]))
  expect(uploaded.size).toBe(3)

  // Forced, it replaces the latest and becomes A's parent.
  const forced = await back(a, 'desk', { force: true })
  expect(stub.commits.at(-1)).toMatchObject({ machine: 'desk', parent: first.id, force: true })
  expect(stub.register.projects[0].latest.id).toBe(forced.id)
  expect((await readBackup(a.home, key))?.parent).toBe(forced.id)
})

it('takes a 409 naming this very backup as latest for success: a retried commit the Worker already made', async () => {
  const other = own()
  const a = await machine(['x'])
  // The commit registers, then its answer is lost and the retry gets the Worker's 409 for it.
  const retried = async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method !== 'POST') return stub.fetch(input, init)
    await stub.fetch(input, init)
    return stub.fetch(input, init)
  }
  const done = await backUp({
    ...cloud,
    key: other,
    chapter: firstChapter,
    machine: 'desk',
    dir: a.home,
    projectRoot: a.projectRoot,
    fetch: retried,
  })
  expect(stub.register.projects.find((project) => project.key === other)?.latest.id).toBe(done.id)
  expect(await readBackup(a.home, other)).toEqual({ key: other, parent: done.id, last: done })
})

it('adopts its own backup the Worker registered behind a 500, and retries the next on top of it', async () => {
  const other = own()
  const a = await machine(['x'])
  // The Worker registers backup 1, then answers 500.
  const lost = async (input: string | URL | Request, init?: RequestInit) => {
    const response = await stub.fetch(input, init)
    return init?.method === 'POST' ? new Response('internal error', { status: 500 }) : response
  }
  await expect(back(a, 'desk', { key: other, fetch: lost })).rejects.toThrow('returned 500')
  const first = stub.register.projects.find((project) => project.key === other)!.latest
  expect(await readBackup(a.home, other)).toBeUndefined()

  const posts = stub.commits.length
  const second = await back(a, 'desk', { key: other })
  // The first commit (parent null) got the 409 naming backup 1; the retry builds on it.
  expect(stub.commits.slice(posts)).toMatchObject([{ parent: null }, { parent: first.id }])
  expect(stub.register.projects.find((project) => project.key === other)!.latest).toMatchObject({
    id: second.id,
    parent: first.id,
  })
  expect((await readBackup(a.home, other))?.parent).toBe(second.id)
})

it('keeps a 409 naming another machine’s backup a conflict, without adopting it', async () => {
  const other = own()
  const a = await machine(['x'])
  const b = await machine(['y'])
  await back(b, 'laptop', { key: other })
  const posts = stub.commits.length
  await expect(back(a, 'desk', { key: other })).rejects.toBeInstanceOf(Conflict)
  expect(stub.commits.length).toBe(posts + 1)
  expect(await readBackup(a.home, other)).toBeUndefined()
})

it('keeps a 409 naming this machine’s backup on another parent a conflict', async () => {
  const other = own()
  const a = await machine(['x'])
  await back(a, 'desk', { key: other })
  // Another home of the same machine name replaced it without building on it.
  const c = await machine(['z'])
  await back(c, 'desk', { key: other, force: true })
  const posts = stub.commits.length
  await expect(back(a, 'desk', { key: other })).rejects.toBeInstanceOf(Conflict)
  expect(stub.commits.length).toBe(posts + 1)
})

it('adopts at most once: a 409 on the retry is final', async () => {
  const other = own()
  const a = await machine(['x'])
  const lost = async (input: string | URL | Request, init?: RequestInit) => {
    const response = await stub.fetch(input, init)
    return init?.method === 'POST' ? new Response('internal error', { status: 500 }) : response
  }
  await expect(back(a, 'desk', { key: other, fetch: lost })).rejects.toThrow('returned 500')
  const first = stub.register.projects.find((project) => project.key === other)!.latest
  // Between the adoption and the retry, another home of this machine builds on backup 1: a 409 the client would
  // adopt again, were adoption not limited to once.
  const b = await machine([])
  await restore({
    ...cloud,
    key: other,
    id: first.id,
    home: b.home,
    projectRoot: a.projectRoot,
    backups: await temp(),
  })
  let posts = 0
  const racing = async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST' && ++posts === 2) await back(b, 'desk', { key: other })
    return stub.fetch(input, init)
  }
  const before = stub.commits.length
  await expect(back(a, 'desk', { key: other, fetch: racing })).rejects.toBeInstanceOf(Conflict)
  expect(stub.register.projects.find((project) => project.key === other)!.latest).toMatchObject({
    machine: 'desk',
    parent: first.id,
  })
  // A's first commit, B's, A's single retry: no third commit from A.
  expect(stub.commits.length - before).toBe(3)
  expect((await readBackup(a.home, other))?.parent).toBe(first.id)
})

it('takes a 409 on a retried chunk upload as stored: objects are write-once', async () => {
  const other = own()
  const a = await machine(['x'])
  // The first chunk PUT is stored, but its answer is lost as a 503; the retry finds it stored.
  let lost = false
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  const flaky = async (input: string | URL | Request, init?: RequestInit) => {
    const response = await stub.fetch(input, init)
    if (init?.method === 'PUT' && !lost) {
      lost = true
      return new Response('unavailable', { status: 503 })
    }
    return response
  }
  vi.stubGlobal('fetch', flaky)
  try {
    const done = back(a, 'desk', { key: other })
    await vi.runAllTimersAsync()
    expect((await done).id).toBe(stub.register.projects.find((p) => p.key === other)!.latest.id)
  } finally {
    vi.useRealTimers()
    vi.stubGlobal('fetch', stub.fetch)
  }
})

it('names an HTTP failure and keeps the parent', async () => {
  const a = await machine(['x'])
  const failing = cloudStub('other')
  vi.stubGlobal('fetch', failing.fetch)
  try {
    const error = await back(a, 'desk').catch((failure: unknown) => failure)
    expect(classify(error)).toBe('HTTP 401')
    expect(existsSync(backupPath(a.home))).toBe(false)
  } finally {
    vi.stubGlobal('fetch', stub.fetch)
  }
})

it('restores into a home: moves the old state aside, installs the backup and records it as parent', async () => {
  const source = await machine(['kept history'])
  const other = own()
  const done = await back(source, 'desk', { key: other })
  const target = await machine(['old state'])
  await writeFile(join(target.home, 'conversations.json'), '[]')
  await writeFile(join(target.home, 'project.json'), '{}')
  const backups = await temp('ultimate-restore-backups-')
  const result = await restore({
    ...cloud,
    key: other,
    id: done.id,
    home: target.home,
    projectRoot: source.projectRoot,
    backups,
    now: new Date('2026-10-21T10:00:00Z'),
  })
  expect(result.backup).toBe(
    join(backups, 'restore-2026-10-21T10-00-00-000Z', target.home.split('/').at(-1)!),
  )
  expect(result.moves).toEqual(['conversations.json', 'state.sqlite'])
  expect(notes(target.home)).toEqual(['kept history'])
  expect(notes(result.backup)).toEqual(['old state'])
  // Settings like project.json stay; the download leaves nothing behind.
  expect((await readdir(target.home)).filter((name) => !name.includes('.lock')).toSorted()).toEqual(
    ['cloud-backup.json', 'project.json', 'state.sqlite'],
  )
  expect(await readBackup(target.home, other)).toEqual({ key: other, parent: done.id, last: done })
})

it('refuses to restore while a chapter switch is pending, and moves nothing', async () => {
  const source = await machine(['a'])
  const other = own()
  const done = await back(source, 'desk', { key: other })
  const target = await machine(['kept'])
  await requestChapter(target.home, 'next')
  await expect(
    restore({
      ...cloud,
      key: other,
      id: done.id,
      home: target.home,
      projectRoot: source.projectRoot,
      backups: await temp(),
    }),
  ).rejects.toThrow('A chapter switch is pending')
  expect(notes(target.home)).toEqual(['kept'])
})

it.each(['ultimate.lock', 'storage.lock'])(
  'refuses to restore while Ultimate holds the home’s %s, and moves nothing',
  async (name) => {
    const source = await machine(['a'])
    const other = own()
    const done = await back(source, 'desk', { key: other })
    const target = await machine(['running'])
    // A supervisor holds ultimate.lock; a standalone server/main.ts holds only storage.lock.
    const lock = await acquireLock(join(target.home, name), { pid: process.pid, port: 4747 })
    try {
      await expect(
        restore({
          ...cloud,
          key: other,
          id: done.id,
          home: target.home,
          projectRoot: source.projectRoot,
          backups: await temp(),
        }),
      ).rejects.toThrow(`Ultimate is running here (pid ${process.pid}`)
      expect(notes(target.home)).toEqual(['running'])
      expect((await readdir(target.home)).filter((file) => file.startsWith('snapshot-'))).toEqual(
        [],
      )
    } finally {
      await lock.close()
    }
  },
)

it('refuses a backup taken of a checkout at another path, before writing anything', async () => {
  const source = await machine(['a'])
  const other = own()
  const done = await back(source, 'desk', { key: other })
  const target = await machine(['mine'])
  await expect(
    restore({
      ...cloud,
      key: other,
      id: done.id,
      home: target.home,
      projectRoot: target.projectRoot,
      backups: await temp(),
    }),
  ).rejects.toThrow(
    `app was backed up from ${source.projectRoot}; restore it into a checkout at that path (paths in conversations and worktrees are absolute)`,
  )
  expect(notes(target.home)).toEqual(['mine'])
  expect(
    (await readdir(target.home)).filter(
      (file) => !file.includes('.lock') && !/-(wal|shm)$/.test(file),
    ),
  ).toEqual(['state.sqlite'])
})

/** A checkout of `project` with a commit, as `pnpm restore` needs to read its identity. */
async function checkout(project: string) {
  const at = await machine([])
  await git(at.projectRoot, 'remote', 'add', 'origin', `https://${project}.git`)
  await git(
    at.projectRoot,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.com',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'root',
  )
  return at
}
/** Run `pnpm restore args` as user `user` against the stub, returning what it printed. */
async function cli(user: string, home: string, ...args: string[]) {
  const printed: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((line: string) => printed.push(line))
  vi.stubEnv('HOME', user)
  vi.stubEnv('ULTIMATE_HOME', home)
  vi.stubEnv('ULTIMATE_CLOUD_URL', cloud.url)
  vi.stubEnv('ULTIMATE_CLOUD_TOKEN', cloud.token)
  vi.stubEnv('ULTIMATE_CLOUD_SNAPSHOT_KEY', cloud.secret)
  try {
    await main(args)
    return printed.join('\n')
  } finally {
    log.mockRestore()
    vi.unstubAllEnvs()
  }
}

it('restores chapters by name, explicit key and snapshot, defaulting to the active chapter', async () => {
  const worker = cloudStub()
  vi.stubGlobal('fetch', worker.fetch)
  try {
    const other = own()
    const source = await checkout(other)
    const first = await back(source, 'desk', { key: other })
    const chapter = 'fresh-roots'
    const chapterKey = `${other}@${chapter}`
    const chapterSource = await machine(['chapter notes'])
    const next = await backUp({
      ...cloud,
      key: chapterKey,
      chapter: { name: chapter, number: 2 },
      machine: 'desk',
      dir: chapterSource.home,
      projectRoot: source.projectRoot,
    })
    // A later chapter's commit carries its own name and number next to its `<key>@<chapter>` key.
    expect(worker.commits.at(-1)).toMatchObject({
      key: chapterKey,
      name: 'app',
      chapter: { name: 'fresh-roots', number: 2 },
    })
    const target = await machine(['keep first'])
    const user = await temp()
    const files = chapterFiles(target.home, chapter)
    const printed = await cli(
      user,
      target.home,
      'app',
      '--chapter',
      chapter,
      '--dir',
      source.projectRoot,
      '--yes',
    )
    expect(printed).toContain(`Installed backup ${next.id}`)
    expect(printed).toContain(files.database)
    expect(notes(files.dir)).toEqual(['chapter notes'])
    expect(notes(target.home)).toEqual(['keep first'])
    expect(await readBackup(files.dir, chapterKey)).toEqual({
      key: chapterKey,
      parent: next.id,
      last: next,
    })
    expect(await readChapters(target.home)).toMatchObject({
      active: chapter,
      chapters: [{ name: FIRST_CHAPTER }, { name: chapter }],
    })
    // No flag now selects the active chapter, including for a named snapshot.
    expect(
      await cli(user, target.home, '--snapshot', next.id, '--dir', source.projectRoot, '--yes'),
    ).toContain(`Installed backup ${next.id}`)
    expect(await readBackup(files.dir, chapterKey)).toMatchObject({
      key: chapterKey,
      parent: next.id,
    })
    expect(notes(target.home)).toEqual(['keep first'])
    // Default register lookup also follows the active chapter.
    expect(await cli(user, target.home, '--dir', source.projectRoot, '--yes')).toContain(
      `Installed backup ${next.id}`,
    )
    // Restoring the first chapter leaves later chapters where they are, and makes the first active.
    expect(
      await cli(
        user,
        target.home,
        '--chapter',
        FIRST_CHAPTER,
        '--dir',
        source.projectRoot,
        '--yes',
      ),
    ).toContain(`Installed backup ${first.id}`)
    expect(notes(files.dir)).toEqual(['chapter notes'])
    expect((await readChapters(target.home)).active).toBe(FIRST_CHAPTER)
    // A chapter key by itself derives the chapter, even in a fresh home.
    const fresh = await temp()
    expect(await cli(user, fresh, chapterKey, '--dir', source.projectRoot, '--yes')).toContain(
      `Installed backup ${next.id}`,
    )
    expect(notes(chapterFiles(fresh, chapter).dir)).toEqual(['chapter notes'])
    expect((await readChapters(fresh)).active).toBe(chapter)
    // The shared project name is not ambiguous: the first chapter still selects the bare key.
    const firstHome = await temp()
    expect(await cli(user, firstHome, 'app', '--dir', source.projectRoot, '--yes')).toContain(
      `Installed backup ${first.id}`,
    )
    expect(await readBackup(firstHome, other)).toEqual({
      key: other,
      parent: first.id,
      last: first,
    })
    expect(existsSync(join(firstHome, 'chapters.json'))).toBe(false)
  } finally {
    vi.stubGlobal('fetch', stub.fetch)
  }
})

it('finishes an interrupted chapter restore under the home journal without moving other chapters', async () => {
  const other = own()
  const source = await checkout(other)
  const nextKey = `${other}@next`
  const snapshot = await back(source, 'desk', { key: nextKey })
  const target = await machine(['first stays'])
  const files = chapterFiles(target.home, 'next')
  await mkdir(files.dir, { recursive: true })
  await writeFile(join(files.dir, 'state.sqlite'), 'old chapter')
  const backups = await temp()
  const now = new Date('2026-10-21T11:00:00Z')
  const backup = join(backups, 'restore-2026-10-21T11-00-00-000Z', 'next')
  await mkdir(backup, { recursive: true })
  await writeFile(join(backup, 'state.sqlite'), 'blocks move')
  await expect(
    restore({
      ...cloud,
      key: nextKey,
      id: snapshot.id,
      home: target.home,
      chapter: 'next',
      projectRoot: source.projectRoot,
      backups,
      now,
    }),
  ).rejects.toThrow('refusing to overwrite the backup')
  expect(JSON.parse(await readFile(join(target.home, 'reset.json'), 'utf8'))).toMatchObject({
    chapter: 'next',
  })
  expect((await readChapters(target.home)).active).toBe(FIRST_CHAPTER)
  await rm(join(backup, 'state.sqlite'))
  // A rerun needs neither the chapter flag nor the cloud register.
  await cli(await temp(), target.home, '--dir', source.projectRoot, '--yes')
  expect(notes(target.home)).toEqual(['first stays'])
  expect(notes(files.dir)).toEqual([])
  expect((await readChapters(target.home)).active).toBe('next')
  expect(await readBackup(files.dir, nextKey)).toMatchObject({ key: nextKey, parent: snapshot.id })
  expect(existsSync(join(target.home, 'reset.json'))).toBe(false)
})

it('restores a named snapshot the register never listed, and warns that it lacks its path', async () => {
  const other = own()
  const source = await machine(['before the register'])
  // Uploaded before the register and before manifests recorded the checkout's path.
  const old = await uploadSnapshot({
    ...cloud,
    key: other,
    machine: 'desk',
    database: join(source.home, 'state.sqlite'),
    repo: source.projectRoot,
  })
  expect(stub.register.projects.some((project) => project.key === other)).toBe(false)
  const target = await checkout(other)
  const printed = await cli(
    await temp(),
    target.home,
    '--snapshot',
    old.id,
    '--dir',
    target.projectRoot,
    '--yes',
  )
  expect(printed).toContain(`Installed backup ${old.id}`)
  expect(printed).toContain('Warning: this backup predates recorded paths')
  expect(notes(target.home)).toEqual(['before the register'])
  expect((await readBackup(target.home, other))?.parent).toBe(old.id)
})

it('leaves an interrupted restore journaled, keeps Ultimate out, and finishes it on a rerun', async () => {
  const other = own()
  const source = await checkout(other)
  const done = await back(source, 'desk', { key: other })
  // The target is the source checkout itself, with its own state, as on a machine restoring at the same path.
  const home = await temp('ultimate-restore-home-')
  const db = new DatabaseSync(join(home, 'state.sqlite'))
  db.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('local')")
  db.close()
  await writeFile(join(home, 'conversations.json'), '[]')
  const backups = await temp('ultimate-restore-backups-')
  const now = new Date('2026-10-21T11:00:00Z')
  const backup = join(backups, 'restore-2026-10-21T11-00-00-000Z', home.split('/').at(-1)!)
  // A file already in the backup fails the second move, after conversations.json went.
  await mkdir(backup, { recursive: true })
  await writeFile(join(backup, 'state.sqlite'), 'in the way')
  const options = {
    ...cloud,
    key: other,
    id: done.id,
    home,
    projectRoot: source.projectRoot,
    backups,
    now,
  }
  await expect(restore(options)).rejects.toThrow('refusing to overwrite the backup')
  expect(existsSync(join(home, 'reset.json'))).toBe(true)
  expect(existsSync(join(backup, 'conversations.json'))).toBe(true)
  expect(existsSync(join(home, `snapshot-${done.id}.sqlite`))).toBe(true)

  // Nothing opens the half-moved home, and neither a fresh restore nor a reset starts over it.
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  await expect(prepared.open(false)).rejects.toThrow(
    `A reset or restore of ${home} was interrupted; rerun pnpm reset or pnpm restore`,
  )
  await expect(restore(options)).rejects.toThrow('run pnpm restore again to finish it')

  // The rerun finishes into the same backup, without the cloud.
  await rm(join(backup, 'state.sqlite'))
  const printed = await cli(await temp(), home, '--dir', source.projectRoot, '--yes')
  expect(printed).toContain(`Installed backup ${done.id}`)
  expect(printed).toContain(`The previous state is in ${backup}`)
  expect(existsSync(join(home, 'reset.json'))).toBe(false)
  expect(notes(home)).toEqual([])
  expect(notes(backup)).toEqual(['local'])
  expect((await readdir(home)).filter((file) => !file.includes('.lock')).toSorted()).toEqual([
    'cloud-backup.json',
    'state.sqlite',
  ])
  expect(await readBackup(home, other)).toEqual({ key: other, parent: done.id, last: done })
  await (await prepared.open(false)).close()
})

it('finds a project in the register by name or key, and names the ones it knows otherwise', () => {
  const register = {
    projects: [
      { ...stub.register.projects[0], name: 'app', key },
      { ...stub.register.projects[0], name: 'blog', key: 'github.com/o/blog' },
    ],
    machines: [],
  }
  expect(findProject(register, 'APP', undefined).key).toBe(key)
  expect(findProject(register, undefined, 'github.com/o/blog').name).toBe('blog')
  expect(() => findProject(register, 'shop', undefined)).toThrow(
    'No backup of shop in the cloud. Backed up: app, blog',
  )
})

it('backs up from the UI, records the refusal as a failed event with the sentence, and forces on request', async () => {
  const userHome = await temp('ultimate-backup-server-')
  const projectRoot = join(userHome, 'app')
  await git(userHome, 'init', '-q', '-b', 'main', projectRoot)
  const other = own()
  await git(projectRoot, 'remote', 'add', 'origin', `https://${other}.git`)
  await git(
    projectRoot,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.com',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'root',
  )
  vi.stubEnv('ULTIMATE_CLOUD_URL', cloud.url)
  vi.stubEnv('ULTIMATE_CLOUD_TOKEN', cloud.token)
  vi.stubEnv('ULTIMATE_CLOUD_SNAPSHOT_KEY', cloud.secret)
  vi.stubEnv('ULTIMATE_CLOUD_MACHINE', 'desk')
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['cloud'] } }),
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome,
    home: join(userHome, 'state'),
  })
  const action = (name: string, args: unknown = null) =>
    post(server, `/api/extensions/cloud/actions/${name}`, { args })
  try {
    const first = await action('backup')
    expect(first.status).toBe(200)
    expect(first.data.result).toMatchObject({ machine: 'desk' })
    expect((await action('state')).data.result).toMatchObject({
      status: 'on',
      name: 'app',
      machine: 'desk',
      lastBackup: { id: first.data.result.id },
    })
    // Another machine backs up after it: this home's parent is stale now.
    stub.register.projects.find((project) => project.key === other)!.latest = {
      ...stub.register.projects.find((project) => project.key === other)!.latest,
      id: 'zz-other',
      machine: 'rog',
    }
    const refused = await action('backup')
    expect(refused.status).not.toBe(200)
    const sentence =
      'rog backed up app after this machine last did; restore its backup or back up anyway to replace it'
    expect(JSON.stringify(refused.data)).toContain(sentence)
    expect((await action('state')).data.result).toMatchObject({
      lastBackup: { id: first.data.result.id },
      conflict: { error: sentence, latest: { id: 'zz-other', machine: 'rog' } },
    })
    const events = await eventHost(() => server.harness, 'test').eventLog.recent({
      events: [BackupEvent],
    })
    expect(events.map((event) => event.data)).toContainEqual(
      expect.objectContaining({ phase: 'failed', reason: 'conflict', error: sentence }),
    )
    // Agents cannot back up; the UI can force it.
    const forced = await action('backup', { force: true })
    expect(forced.status).toBe(200)
    expect(stub.commits.at(-1)).toMatchObject({ force: true, parent: first.data.result.id })
    expect((await action('state')).data.result).not.toHaveProperty('conflict')
  } finally {
    await server.close()
    vi.unstubAllEnvs()
  }
})
