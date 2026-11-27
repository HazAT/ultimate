import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, open as openFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createZstdCompress, createZstdDecompress } from 'node:zlib'
import { pace } from '../../lib/timers.shared.ts'
import { vacuum } from '../../lib/database-files.ts'
import { git as gitIn } from '../../lib/git.ts'

export interface SnapshotManifest {
  id: string
  key: string
  epoch?: RetiredLeaseEpoch
  createdAt: number
  machine: string
  root?: string
  database: Part
  bundle?: Part
}
type UncompressedBytes = number
type EncryptedChunkBytes = number
type RetiredLeaseEpoch = number

interface Part {
  sha256: string
  bytes: UncompressedBytes
  chunks: number
  uploaded?: EncryptedChunkBytes
}
type Kind = 'db' | 'bundle'
interface Remote {
  url: string
  token: string
  secret: string
  key: string
  signal?: AbortSignal
}

const WORKER_SAFE_CHUNK_BYTES = 16 * 1024 * 1024
const AES_GCM_NONCE_BYTES = 12
const AES_GCM_TAG_BYTES = 16
const CREATE_REF_ONLY_IF_ABSENT = ''
const ULTIMATE_REF_NAMESPACE = 'refs/heads/ultimate'
const gitWithoutTimeout = (repo: string, ...args: string[]) =>
  gitIn({ cwd: repo, timeout: 0, maxBuffer: 16 * 1024 * 1024 }, ...args)
const compareAndSwapRef = (repo: string, ref: string, next: string, expected: string) =>
  gitWithoutTimeout(repo, 'update-ref', ref, next, expected)

export async function uploadSnapshot(o: {
  url: string
  token: string
  secret: string
  key: string
  machine: string
  database: string
  repo: string
  root?: string
  signal?: AbortSignal
  progress?: (done: number, total: number, uploaded: number) => void
}): Promise<SnapshotManifest> {
  const id = `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`
  const temp = await mkdtemp(join(dirname(o.database), '.snapshot-'))
  try {
    const copy = join(temp, 'database.sqlite')
    await vacuum(o.database, copy)
    let bundle: string | undefined
    if (await gitWithoutTimeout(o.repo, 'for-each-ref', '--count=1', ULTIMATE_REF_NAMESPACE)) {
      bundle = join(temp, 'branches.bundle')
      await gitWithoutTimeout(
        o.repo,
        'bundle',
        'create',
        '--quiet',
        bundle,
        '--branches=ultimate/*',
      )
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
    await commitCompletedSnapshotManifest(o, id, manifest)
    return manifest
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

export async function downloadSnapshot(o: {
  url: string
  token: string
  secret: string
  key: string
  id: string
  dir: string
  repo: string
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
    await rm(`${database}.part`, { force: true })
    await rm(database, { force: true })
    throw error
  } finally {
    await rm(bundle, { force: true })
  }
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value))

const commitCompletedSnapshotManifest = (remote: Remote, id: string, manifest: SnapshotManifest) =>
  put(remote, id, 'manifest', encrypt(remote, id, 'manifest', 0, true, json(manifest)))

function snapshotCipherKey(o: Remote, id: string) {
  return Buffer.from(hkdfSync('sha256', o.secret, o.key, `ultimate-snapshot:${id}`, 32))
}
const authenticatedChunkBoundary = (id: string, kind: string, index: number, last: boolean) =>
  Buffer.from(`${id}:${kind}:${index}:${last ? 'last' : 'more'}`)

function encrypt(o: Remote, id: string, kind: string, index: number, last: boolean, data: Buffer) {
  const nonce = randomBytes(AES_GCM_NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', snapshotCipherKey(o, id), nonce)
  cipher.setAAD(authenticatedChunkBoundary(id, kind, index, last))
  return Buffer.concat([nonce, cipher.update(data), cipher.final(), cipher.getAuthTag()])
}
function decrypt(o: Remote, id: string, kind: string, index: number, last: boolean, data: Buffer) {
  try {
    if (data.length < AES_GCM_NONCE_BYTES + AES_GCM_TAG_BYTES) throw new Error('short chunk')
    const decipher = createDecipheriv(
      'aes-256-gcm',
      snapshotCipherKey(o, id),
      data.subarray(0, AES_GCM_NONCE_BYTES),
    )
    decipher.setAAD(authenticatedChunkBoundary(id, kind, index, last))
    decipher.setAuthTag(data.subarray(-AES_GCM_TAG_BYTES))
    return Buffer.concat([
      decipher.update(data.subarray(AES_GCM_NONCE_BYTES, -AES_GCM_TAG_BYTES)),
      decipher.final(),
    ])
  } catch {
    throw new Error(`Snapshot ${id} failed verification (${kind} ${index})`)
  }
}

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
  let pendingFinalChunk: Buffer | undefined
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
        while (size >= WORKER_SAFE_CHUNK_BYTES) {
          const all = Buffer.concat(pieces)
          if (pendingFinalChunk) await upload(pendingFinalChunk, false)
          pendingFinalChunk = all.subarray(0, WORKER_SAFE_CHUNK_BYTES)
          pieces = [all.subarray(WORKER_SAFE_CHUNK_BYTES)]
          size -= WORKER_SAFE_CHUNK_BYTES
        }
      }
      const rest = Buffer.concat(pieces)
      if (pendingFinalChunk) await upload(pendingFinalChunk, rest.length === 0)
      if (rest.length || !pendingFinalChunk) await upload(rest, true)
    },
    { signal: o.signal },
  )
  return { sha256: hash.digest('hex'), bytes, chunks, uploaded }
}

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
  const fileOpenedBeforePipeline = await openFile(file, 'w')
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
    fileOpenedBeforePipeline.createWriteStream(),
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

async function request(o: Remote, id: string, name: string, init: RequestInit) {
  const url = objectUrl(o, id, name)
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, {
      ...init,
      signal: o.signal,
      headers: { Authorization: `Bearer ${o.token}` },
    }).catch((error: unknown) => {
      if (o.signal?.aborted || attempt === 3) throw error
      return undefined
    })
    if (response?.ok) return response
    const retriedPutAlreadyStored = response?.status === 409 && init.method === 'PUT' && attempt > 1
    if (retriedPutAlreadyStored) return response
    if (response && (response.status < 500 || attempt === 3))
      throw new Error(`Snapshot ${name} returned ${response.status}`)
    await response?.body?.cancel()
    await pace(1000 * attempt, o.signal)
  }
}
async function put(o: Remote, id: string, name: string, data: Buffer) {
  await request(o, id, name, { method: 'PUT', body: new Uint8Array(data) })
}
async function get(o: Remote, id: string, name: string) {
  return Buffer.from(await (await request(o, id, name, { method: 'GET' })).arrayBuffer())
}

async function fetchBranches(repo: string, bundle: string, id: string) {
  await gitWithoutTimeout(repo, 'bundle', 'verify', '--quiet', bundle)
  const heads = (await gitWithoutTimeout(repo, 'bundle', 'unbundle', bundle))
    .split('\n')
    .map((line) => line.split(' ') as [string, string])
    .filter(([, ref]) => ref?.startsWith(`${ULTIMATE_REF_NAMESPACE}/`))
  const local = new Map(
    (
      await gitWithoutTimeout(
        repo,
        'for-each-ref',
        '--format=%(refname) %(objectname)',
        ULTIMATE_REF_NAMESPACE,
      )
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' ') as [string, string]),
  )
  const checkedOut = new Set(
    (await gitWithoutTimeout(repo, 'worktree', 'list', '--porcelain'))
      .split('\n')
      .filter((line) => line.startsWith('branch '))
      .map((line) => line.slice('branch '.length)),
  )
  const contains = (descendant: string, ancestor: string) =>
    gitWithoutTimeout(repo, 'merge-base', '--is-ancestor', ancestor, descendant).then(
      () => true,
      () => false,
    )
  const kept: string[] = []
  for (const [oid, ref] of heads) {
    const current = local.get(ref)
    if (!current) await gitWithoutTimeout(repo, 'update-ref', ref, oid, CREATE_REF_ONLY_IF_ABSENT)
    else if (current === oid || (await contains(current, oid))) continue
    else if (!checkedOut.has(ref) && (await contains(oid, current)))
      await compareAndSwapRef(repo, ref, oid, current)
    else {
      const moved = `refs/heads/ultimate-moved/${id}/${ref.slice(ULTIMATE_REF_NAMESPACE.length + 1)}`
      const previouslyKeptSnapshotCommit = await gitWithoutTimeout(
        repo,
        'rev-parse',
        '--verify',
        '--quiet',
        moved,
      ).catch(() => '')
      if (previouslyKeptSnapshotCommit !== oid)
        await gitWithoutTimeout(repo, 'update-ref', moved, oid, CREATE_REF_ONLY_IF_ABSENT)
      kept.push(moved)
    }
  }
  return kept
}
