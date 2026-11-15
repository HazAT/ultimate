// One cloud backup: upload the snapshot, then commit it to the Worker's register with the parent it builds on.
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { httpBase } from '../../lib/cloud.ts'
import { meansNone } from '../../lib/errors.ts'
import { readJson, writeJson } from '../../lib/json-file.ts'
import { uploadSnapshot } from './snapshot.ts'
import type { LastBackup } from './types.ts'

/**
 * `cloud-backup.json` in the chapter's folder (the home for the first chapter): the chapter's key, `parent` (the snapshot this home last uploaded or restored from, which
 * the next backup builds on) and that backup's facts.
 */
export interface BackupFile {
  key: string
  parent: string
  last: LastBackup
}
export const backupPath = (dir: string) => join(dir, 'cloud-backup.json')

/**
 * The backup key of a chapter: the project's key for the first chapter, `<key>@<chapter>` for the others, so each
 * chapter keeps its own chain and retention in the Worker.
 */
export const chapterKey = (key: string, chapter: string, first: boolean) =>
  first ? key : `${key}@${chapter}`

/** The backup record in chapter folder `dir` for `key`; undefined without one, or for another key. */
export async function readBackup(dir: string, key: string) {
  const file = await readJson<Partial<BackupFile> | undefined>(backupPath(dir), undefined).catch(
    meansNone,
  )
  return file?.key === key && file.parent && file.last ? (file as BackupFile) : undefined
}
export const writeBackup = (dir: string, file: BackupFile) => writeJson(backupPath(dir), file)

/** The backup a forced one replaces, as the Worker's 409 names it. */
export type Latest = Pick<LastBackup, 'id' | 'machine' | 'at'>

/** The Worker refused the commit: another machine backed up after `parent`. `message` is its sentence. */
export class Conflict extends Error {
  readonly latest: Latest | undefined
  constructor(message: string, latest: Latest | undefined) {
    super(message)
    this.latest = latest
  }
}

export interface BackupOptions {
  url: string
  token: string
  /** `ULTIMATE_CLOUD_SNAPSHOT_KEY`. */
  secret: string
  machine: string
  /** The chapter's key (`chapterKey`). */
  key: string
  /** The chapter the backup belongs to, named in the commit so the fleet can group a project's chapters. */
  chapter: { name: string; number: number }
  /** The active chapter's folder: its `state.sqlite` and `cloud-backup.json`. */
  dir: string
  projectRoot: string
  /** Replace the latest backup even when it is not this home's parent. */
  force?: boolean
  tailnet?: string
  signal?: AbortSignal
  progress?: (done: number, total: number, uploaded: number) => void
  fetch?: typeof fetch
}

/**
 * Upload a snapshot of the chapter's `state.sqlite` and the `ultimate/*` branches, then `POST /sync/backups/<p>/<id>` with the
 * parent from `cloud-backup.json`. On 200 the record names the new backup as parent; on 409 it stays and `Conflict`
 * carries the Worker's sentence. Uploaded chunks of a refused backup stay for the Worker's retention.
 *
 * Two 409s are this machine's own: one naming this very backup (a retried commit the Worker already made) is success,
 * and one naming a backup this machine made on top of its recorded parent (registered, but answered with a 500) is
 * adopted as the parent, and the commit retried once on it.
 */
export async function backUp(o: BackupOptions): Promise<LastBackup> {
  const record = await readBackup(o.dir, o.key)
  const manifest = await uploadSnapshot({
    url: o.url,
    token: o.token,
    secret: o.secret,
    key: o.key,
    machine: o.machine,
    database: join(o.dir, 'state.sqlite'),
    repo: o.projectRoot,
    root: o.projectRoot,
    signal: o.signal,
    progress: o.progress,
  })
  const done: LastBackup = {
    id: manifest.id,
    at: manifest.createdAt,
    machine: o.machine,
    bytes: manifest.database.bytes + (manifest.bundle?.bytes ?? 0),
    uploaded: (manifest.database.uploaded ?? 0) + (manifest.bundle?.uploaded ?? 0),
  }
  const project = createHash('sha256').update(o.key).digest('hex')
  const commit = (parent: string | null) =>
    (o.fetch ?? fetch)(new URL(`/sync/backups/${project}/${manifest.id}`, httpBase(o.url)), {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: o.key,
        name: basename(o.projectRoot),
        chapter: { name: o.chapter.name, number: o.chapter.number },
        machine: o.machine,
        parent,
        ...(o.force ? { force: true } : {}),
        createdAt: done.at,
        bytes: done.bytes,
        uploaded: done.uploaded,
        ...(o.tailnet ? { tailnet: o.tailnet } : {}),
      }),
      signal: o.signal,
    })
  let parent = record?.parent ?? null
  let response = await commit(parent)
  for (let adopted = false; response.status === 409; adopted = true) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: unknown
      latest?: (Partial<LastBackup> & { parent?: string | null }) | null
    }
    const latest = body.latest ?? {}
    const { id, machine, at } = latest
    // A retry after the Worker registered this backup but failed to answer: the latest is ours.
    if (id === done.id) {
      await writeBackup(o.dir, { key: o.key, parent: done.id, last: done })
      return done
    }
    // This machine's previous backup, registered on top of our parent though its answer was lost: build on it.
    if (
      !adopted &&
      typeof id === 'string' &&
      machine === o.machine &&
      (latest.parent ?? null) === parent &&
      typeof at === 'number'
    ) {
      parent = id
      await writeBackup(o.dir, {
        key: o.key,
        parent: id,
        last: { id, at, machine, bytes: latest.bytes ?? 0, uploaded: latest.uploaded ?? 0 },
      })
      response = await commit(parent)
      continue
    }
    throw new Conflict(
      typeof body.error === 'string' ? body.error : 'Another machine backed up this project first',
      typeof id === 'string' && typeof machine === 'string' && typeof at === 'number'
        ? { id, machine, at }
        : undefined,
    )
  }
  if (!response.ok)
    throw new Error(`POST /sync/backups returned ${response.status}: ${await response.text()}`)
  await writeBackup(o.dir, { key: o.key, parent: done.id, last: done })
  return done
}

/** Classified failure reasons, first match wins: an event names one of these, never the raw error. */
const REASONS: [RegExp, string][] = [
  [/^Missing ULTIMATE_CLOUD_SNAPSHOT_KEY/, 'missing snapshot key'],
  [/integrity|verification|does not match/, 'integrity check failed'],
  [/timeout|timed out|aborted/i, 'timed out'],
]
/** `reason` of a failed `cloud.backup`: `conflict`, a known cause, an HTTP status, or `failed`. */
export function classify(error: unknown) {
  if (error instanceof Conflict) return 'conflict'
  const message = error instanceof Error ? error.message : String(error)
  const known = REASONS.find(([pattern]) => pattern.test(message))
  if (known) return known[1]
  const status = /returned ([45]\d\d)\b/.exec(message)
  return status ? `HTTP ${status[1]}` : 'failed'
}
