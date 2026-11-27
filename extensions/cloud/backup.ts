import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { httpBase } from '../../lib/cloud.ts'
import { meansNone } from '../../lib/errors.shared.ts'
import { readJson, writeJson } from '../../lib/json-file.ts'
import { uploadSnapshot } from './snapshot.ts'
import type { LastBackup } from './types.ts'

export interface BackupFile {
  key: string
  parent: string
  last: LastBackup
}
export const backupPath = (dir: string) => join(dir, 'cloud-backup.json')

export const chapterKey = (key: string, chapter: string, first: boolean) =>
  first ? key : `${key}@${chapter}`

export async function readBackup(dir: string, key: string) {
  const file = await readJson<Partial<BackupFile> | undefined>(backupPath(dir), undefined).catch(
    meansNone,
  )
  return file?.key === key && file.parent && file.last ? (file as BackupFile) : undefined
}
export const writeBackup = (dir: string, file: BackupFile) => writeJson(backupPath(dir), file)

export type Latest = Pick<LastBackup, 'id' | 'machine' | 'at'>

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
  secret: string
  machine: string
  key: string
  chapter: { name: string; number: number }
  dir: string
  projectRoot: string
  force?: boolean
  tailnet?: string
  signal?: AbortSignal
  progress?: (done: number, total: number, uploaded: number) => void
  fetch?: typeof fetch
}

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
  for (let adoptedLostReplyOnce = false; response.status === 409; adoptedLostReplyOnce = true) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: unknown
      latest?: (Partial<LastBackup> & { parent?: string | null }) | null
    }
    const latest = body.latest ?? {}
    const { id, machine, at } = latest
    const commitAlreadyRegistered = id === done.id
    if (commitAlreadyRegistered) {
      await writeBackup(o.dir, { key: o.key, parent: done.id, last: done })
      return done
    }
    const ownLostReplyBuiltOnRecordedParent =
      !adoptedLostReplyOnce &&
      typeof id === 'string' &&
      machine === o.machine &&
      (latest.parent ?? null) === parent &&
      typeof at === 'number'
    if (ownLostReplyBuiltOnRecordedParent) {
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

const FIRST_MATCH_FAILURE_REASONS: [RegExp, string][] = [
  [/^Missing ULTIMATE_CLOUD_SNAPSHOT_KEY/, 'missing snapshot key'],
  [/integrity|verification|does not match/, 'integrity check failed'],
  [/timeout|timed out|aborted/i, 'timed out'],
]
export function classify(error: unknown) {
  if (error instanceof Conflict) return 'conflict'
  const message = error instanceof Error ? error.message : String(error)
  const known = FIRST_MATCH_FAILURE_REASONS.find(([pattern]) => pattern.test(message))
  if (known) return known[1]
  const status = /returned ([45]\d\d)\b/.exec(message)
  return status ? `HTTP ${status[1]}` : 'failed'
}
