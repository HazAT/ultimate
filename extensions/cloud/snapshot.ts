// Encrypted, chunked project backups in the cloud's private R2: a consistent database copy plus a bundle of the
// `ultimate/*` branches. Everything is compressed and sealed on the machine; the Worker stores only ciphertext.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, open as openFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { createZstdCompress, createZstdDecompress } from 'node:zlib'
import { vacuum } from '../../lib/database-files.ts'
import { git as gitIn } from '../../lib/git.ts'

export interface SnapshotManifest {
  id: string
  key: string
  /** Set by snapshots uploaded for the retired lease; read and ignored. */
  epoch?: number
  createdAt: number
  machine: string
  /** The project checkout it was taken from; conversations and worktrees name absolute paths in it. Older lack it. */
  root?: string
  database: Part
  bundle?: Part
}
/**
 * One uploaded file: `bytes` before compression, `uploaded` the encrypted chunks put to R2 (compressed, with nonce and
 * tag per chunk). Snapshots uploaded before `uploaded` was recorded lack it.
 */
interface Part {
  sha256: string
  bytes: number
  chunks: number
  uploaded?: number
}
type Kind = 'db' | 'bundle'
interface Remote {
  url: string
  token: string
  secret: string
  key: string
  signal?: AbortSignal
}

/** Compressed bytes per chunk; with nonce and tag each object stays under the Worker's 17 MiB limit. */
const CHUNK = 16 * 1024 * 1024
// A for-each-ref pattern without a trailing slash matches refs below it, not `ultimate-moved/`.
const BRANCHES = 'refs/heads/ultimate'
/** Bundles take as long as they take and list every branch. */
const git = (repo: string, ...args: string[]) =>
  gitIn({ cwd: repo, timeout: 0, maxBuffer: 16 * 1024 * 1024 }, ...args)

/**
 * Copy a closed or open SQLite file consistently (VACUUM INTO via node:sqlite, read-only), compress (zlib zstd), encrypt
 * and upload. `progress` gets the bytes read of `total` (both before compression) and the bytes uploaded so far; the
 * upload's own total is known only at the end, in the manifest.
 */
export async function uploadSnapshot(o: {
  url: string
  token: string
  secret: string
  key: string
  machine: string
  database: string
  repo: string
  /** The project checkout, recorded in the manifest. */
  root?: string
  signal?: AbortSignal
  progress?: (done: number, total: number, uploaded: number) => void
}): Promise<SnapshotManifest> {
  const id = `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`
  const temp = await mkdtemp(join(dirname(o.database), '.snapshot-'))
  try {
    const copy = join(temp, 'database.sqlite')
    vacuum(o.database, copy)
    let bundle: string | undefined
    if (await git(o.repo, 'for-each-ref', '--count=1', BRANCHES)) {
      bundle = join(temp, 'branches.bundle')
      await git(o.repo, 'bundle', 'create', '--quiet', bundle, '--branches=ultimate/*')
    }
    const sizes = [(await stat(copy)).size, bundle ? (await stat(bundle)).size : 0]
    const total = sizes[0] + sizes[1]
    const report = (read: number, sent: number) => (done: number, uploaded: number) =>
      o.progress?.(read + done, total, sent + uploaded)
    const db = await seal(o, id, 'db', copy, report(0, 0))
    const manifest: SnapshotManifest = {
      id,
      key: o.key,
      createdAt: Date.now(),
      machine: o.machine,
      ...(o.root ? { root: o.root } : {}),
      database: db,
      bundle: bundle
        ? await seal(o, id, 'bundle', bundle, report(sizes[0], db.uploaded!))
        : undefined,
    }
    // The manifest goes last: it makes the snapshot complete and starts the Worker's retention.
    await put(o, id, 'manifest', encrypt(o, id, 'manifest', 0, true, json(manifest)))
    return manifest
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

/** Download, verify and decrypt into `<dir>/snapshot-<id>.sqlite` (integrity_check ok) and fetch the bundle's refs into `repo`. Returns the database path and the moved-aside refs. */
export async function downloadSnapshot(o: {
  url: string
  token: string
  secret: string
  key: string
  id: string
  dir: string
  repo: string
  /** Refuse, before writing anything, a snapshot taken of a checkout at another path. */
  root?: string
  signal?: AbortSignal
  progress?: (done: number, total: number) => void
}): Promise<{ database: string; manifest: SnapshotManifest; keptRefs: string[] }> {
  const manifest = JSON.parse(
    decrypt(o, o.id, 'manifest', 0, true, await get(o, o.id, 'manifest')).toString(),
  ) as SnapshotManifest
  if (manifest.id !== o.id || manifest.key !== o.key)
    throw new Error(`Snapshot ${o.id} belongs to another project`)
  if (o.root && manifest.root && manifest.root !== o.root)
    throw new Error(
      `${basename(manifest.root)} was backed up from ${manifest.root}; restore it into a checkout at that path (paths in conversations and worktrees are absolute)`,
    )
  const total = manifest.database.bytes + (manifest.bundle?.bytes ?? 0)
  const database = join(o.dir, `snapshot-${o.id}.sqlite`)
  const bundle = join(o.dir, `snapshot-${o.id}.bundle`)
  // The size is known from the manifest, before the first chunk arrives.
  o.progress?.(0, total)
  try {
    await open(o, manifest.database, o.id, 'db', `${database}.part`, (done) =>
      o.progress?.(done, total),
    )
    await rename(`${database}.part`, database)
    const db = new DatabaseSync(database, { readOnly: true })
    try {
      const rows = db.prepare('PRAGMA integrity_check').all()
      if (rows.length !== 1 || rows[0].integrity_check !== 'ok')
        throw new Error(`Snapshot ${o.id} failed the integrity check`)
    } finally {
      db.close()
    }
    if (!manifest.bundle) return { database, manifest, keptRefs: [] }
    await open(o, manifest.bundle, o.id, 'bundle', bundle, (done) =>
      o.progress?.(manifest.database.bytes + done, total),
    )
    return { database, manifest, keptRefs: await fetchBranches(o.repo, bundle, o.id) }
  } catch (error) {
    // Only this download's own files go: the project's database and refs are never touched on failure.
    await rm(`${database}.part`, { force: true })
    await rm(database, { force: true })
    throw error
  } finally {
    await rm(bundle, { force: true })
  }
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value))

/** Per snapshot key: HKDF-SHA256 over the user's secret, salted with the project key. */
function cipherKey(o: Remote, id: string) {
  return Buffer.from(hkdfSync('sha256', o.secret, o.key, `ultimate-snapshot:${id}`, 32))
}
// The position and the last-chunk flag are authenticated, so chunks cannot be reordered, swapped or dropped.
const aad = (id: string, kind: string, index: number, last: boolean) =>
  Buffer.from(`${id}:${kind}:${index}:${last ? 'last' : 'more'}`)

/** nonce (12) ‖ AES-256-GCM ciphertext ‖ tag (16) */
function encrypt(o: Remote, id: string, kind: string, index: number, last: boolean, data: Buffer) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', cipherKey(o, id), nonce)
  cipher.setAAD(aad(id, kind, index, last))
  return Buffer.concat([nonce, cipher.update(data), cipher.final(), cipher.getAuthTag()])
}
function decrypt(o: Remote, id: string, kind: string, index: number, last: boolean, data: Buffer) {
  try {
    if (data.length < 28) throw new Error('short chunk')
    const decipher = createDecipheriv('aes-256-gcm', cipherKey(o, id), data.subarray(0, 12))
    decipher.setAAD(aad(id, kind, index, last))
    decipher.setAuthTag(data.subarray(-16))
    return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()])
  } catch {
    // GCM reports every mismatch alike; the cause is a wrong secret or project, or altered objects.
    throw new Error(`Snapshot ${id} failed verification (${kind} ${index})`)
  }
}

/** Compress, chunk, encrypt and upload one file, hashing its plaintext and counting the bytes put. */
async function seal(
  o: Remote,
  id: string,
  kind: Kind,
  file: string,
  progress: (done: number, uploaded: number) => void,
): Promise<Part> {
  const hash = createHash('sha256')
  let bytes = 0
  let uploaded = 0
  let chunks = 0
  // One full chunk is held back until the next exists, so the final one is known and marked last.
  let held: Buffer | undefined
  const upload = async (data: Buffer, last: boolean) => {
    const index = chunks++
    const sealed = encrypt(o, id, kind, index, last, data)
    await put(o, id, `${kind}-${index}`, sealed)
    uploaded += sealed.length
    progress(bytes, uploaded)
  }
  await pipeline(
    createReadStream(file),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const data of source) {
        hash.update(data)
        bytes += data.length
        yield data
      }
    },
    createZstdCompress(),
    async (source: AsyncIterable<Buffer>) => {
      let pieces: Buffer[] = []
      let size = 0
      for await (const piece of source) {
        pieces.push(piece)
        size += piece.length
        while (size >= CHUNK) {
          const all = Buffer.concat(pieces)
          if (held) await upload(held, false)
          held = all.subarray(0, CHUNK)
          pieces = [all.subarray(CHUNK)]
          size -= CHUNK
        }
      }
      const rest = Buffer.concat(pieces)
      if (held) await upload(held, rest.length === 0)
      if (rest.length || !held) await upload(rest, true)
    },
    { signal: o.signal },
  )
  return { sha256: hash.digest('hex'), bytes, chunks, uploaded }
}

/** Download, decrypt and decompress one file, checking its size and plaintext hash. */
async function open(
  o: Remote,
  part: Part,
  id: string,
  kind: Kind,
  file: string,
  progress: (done: number) => void,
) {
  const hash = createHash('sha256')
  let bytes = 0
  // Open before the pipeline starts: createWriteStream(path) opens the file later on the threadpool, so a first chunk
  // that fails verification at once can reject the pipeline first, and the queued open recreates an empty file after
  // the caller's rm (seen as a leftover .part in the 'rejects reordered chunks' test under load).
  const out = await openFile(file, 'w')
  await pipeline(
    Readable.from(
      (async function* () {
        for (let index = 0; index < part.chunks; index++) {
          const last = index === part.chunks - 1
          yield decrypt(o, id, kind, index, last, await get(o, id, `${kind}-${index}`))
        }
      })(),
    ),
    createZstdDecompress(),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const data of source) {
        hash.update(data)
        bytes += data.length
        progress(bytes)
        yield data
      }
    },
    out.createWriteStream(),
    { signal: o.signal },
  )
  if (bytes !== part.bytes || hash.digest('hex') !== part.sha256)
    throw new Error(`Snapshot ${id} ${kind} does not match its manifest`)
}

function objectUrl(o: Remote, id: string, name: string) {
  const url = new URL(o.url)
  if (url.protocol === 'wss:') url.protocol = 'https:'
  else if (url.protocol === 'ws:') url.protocol = 'http:'
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error('Cloud snapshots require HTTPS')
  const project = createHash('sha256').update(o.key).digest('hex')
  url.pathname = `/sync/snapshots/${project}/${id}/${name}`
  url.search = ''
  return url
}

/** One request, retried twice after network errors and server failures; other statuses are final. */
async function request(o: Remote, id: string, name: string, init: RequestInit) {
  const url = objectUrl(o, id, name)
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, {
      ...init,
      signal: o.signal,
      headers: { Authorization: `Bearer ${o.token}` },
    }).catch((error: unknown) => {
      if (o.signal?.aborted || attempt === 3) throw error
      // A network error is retried below.
      return undefined
    })
    if (response?.ok) return response
    // Objects are write-once: a retried PUT that finds its object stored means the first attempt landed.
    if (response?.status === 409 && init.method === 'PUT' && attempt > 1) return response
    if (response && (response.status < 500 || attempt === 3))
      throw new Error(`Snapshot ${name} returned ${response.status}`)
    await response?.body?.cancel()
    await sleep(1000 * attempt, undefined, { signal: o.signal })
  }
}
async function put(o: Remote, id: string, name: string, data: Buffer) {
  await request(o, id, name, { method: 'PUT', body: new Uint8Array(data) })
}
async function get(o: Remote, id: string, name: string) {
  return Buffer.from(await (await request(o, id, name, { method: 'GET' })).arrayBuffer())
}

/**
 * Unbundle the snapshot's `ultimate/*` branches into `repo` without force. A new branch is created and a strictly
 * older one fast-forwarded unless it is checked out; one already containing the incoming commit stays. Anything else
 * keeps the local branch and stores the incoming commit as `refs/heads/ultimate-moved/<id>/<name>`.
 */
async function fetchBranches(repo: string, bundle: string, id: string) {
  await git(repo, 'bundle', 'verify', '--quiet', bundle)
  const heads = (await git(repo, 'bundle', 'unbundle', bundle))
    .split('\n')
    .map((line) => line.split(' ') as [string, string])
    .filter(([, ref]) => ref?.startsWith(`${BRANCHES}/`))
  const local = new Map(
    (await git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', BRANCHES))
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' ') as [string, string]),
  )
  const checkedOut = new Set(
    (await git(repo, 'worktree', 'list', '--porcelain'))
      .split('\n')
      .filter((line) => line.startsWith('branch '))
      .map((line) => line.slice('branch '.length)),
  )
  const contains = (descendant: string, ancestor: string) =>
    git(repo, 'merge-base', '--is-ancestor', ancestor, descendant).then(
      () => true,
      // merge-base exits 1 for "not an ancestor".
      () => false,
    )
  const kept: string[] = []
  for (const [oid, ref] of heads) {
    const current = local.get(ref)
    // The empty old value makes update-ref create only, and a given one makes it compare-and-swap.
    if (!current) await git(repo, 'update-ref', ref, oid, '')
    else if (current === oid || (await contains(current, oid))) continue
    else if (!checkedOut.has(ref) && (await contains(oid, current)))
      await git(repo, 'update-ref', ref, oid, current)
    else {
      const moved = `refs/heads/ultimate-moved/${id}/${ref.slice(BRANCHES.length + 1)}`
      // A repeated download of this snapshot finds its own kept ref already in place.
      const existing = await git(repo, 'rev-parse', '--verify', '--quiet', moved).catch(
        // --verify fails for an absent ref.
        () => '',
      )
      if (existing !== oid) await git(repo, 'update-ref', moved, oid, '')
      kept.push(moved)
    }
  }
  return kept
}
