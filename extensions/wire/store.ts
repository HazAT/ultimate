/**
 * Wire's files: one gzipped JSON file per model call, `<home>/wire/<conversation>/<n>.json.gz`, outside the durable
 * database. Each conversation keeps its newest `PER_CONVERSATION` calls; the whole folder stays under `TOTAL_BYTES`,
 * the oldest calls of any conversation going first.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { WireCall, WireSummary } from './refs.ts'

export const PER_CONVERSATION = 20
export const TOTAL_BYTES = 300 * 1024 * 1024

export const folder = (home: string) => join(home, 'wire')
const name = (n: number) => `${String(n).padStart(8, '0')}.json.gz`
const summaryName = (n: number) => `${String(n).padStart(8, '0')}.summary.json`
/** A call's file and its summary beside it. */
const drop = async (path: string) => {
  await rm(path.replace(/\.json\.gz$/u, '.summary.json'), { force: true })
  await rm(path, { force: true })
}
const numberOf = (file: string) => Number(/^(\d{8})\.json\.gz$/.exec(file)?.[1] ?? NaN)

const missingAsEmpty = (error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return []
  throw error
}

async function calls(dir: string): Promise<number[]> {
  const files = await readdir(dir).catch(missingAsEmpty)
  return files
    .map(numberOf)
    .filter(Number.isFinite)
    .toSorted((a, b) => a - b)
}

/** Every write runs after the one before, so call numbers never collide and pruning never races a write. */
let writes: Promise<unknown> = Promise.resolve()

/**
 * Store `call` as its conversation's next one, drop the conversation's calls past the window and keep the folder
 * under `TOTAL_BYTES`; returns its number.
 */
export function save(home: string, call: Omit<WireCall, 'n'>): Promise<number> {
  const dir = join(folder(home), String(call.conversationId))
  const run = writes
    .catch(() => {
      // The previous write's caller got its failure; this one still runs.
    })
    .then(async () => {
      await mkdir(dir, { recursive: true })
      const existing = await calls(dir)
      const n = (existing.at(-1) ?? 0) + 1
      await writeFile(join(dir, summaryName(n)), JSON.stringify(summarize({ ...call, n })))
      await writeFile(join(dir, name(n)), gzipSync(JSON.stringify({ ...call, n })))
      for (const old of existing.slice(0, Math.max(0, existing.length + 1 - PER_CONVERSATION)))
        await drop(join(dir, name(old)))
      await prune(home)
      return n
    })
  writes = run
  return run
}

export async function load(
  home: string,
  conversationId: number,
  n: number,
): Promise<WireCall | undefined> {
  const bytes = await readFile(join(folder(home), String(conversationId), name(n))).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    },
  )
  return bytes && (JSON.parse(gunzipSync(bytes).toString('utf8')) as WireCall)
}

/** The conversation's stored calls, oldest first, without their bodies (read from each call's small summary file). */
export async function list(home: string, conversationId: number): Promise<WireSummary[]> {
  const dir = join(folder(home), String(conversationId))
  return Promise.all(
    (await calls(dir)).map(
      async (n) => JSON.parse(await readFile(join(dir, summaryName(n)), 'utf8')) as WireSummary,
    ),
  )
}

export function summarize(call: WireCall): WireSummary {
  const {
    request,
    response,
    message: _message,
    requestHeaders: _requestHeaders,
    responseHeaders: _responseHeaders,
    ...rest
  } = call
  return {
    ...rest,
    requestBytes: Buffer.byteLength(request),
    ...(response === undefined ? {} : { responseBytes: Buffer.byteLength(response) }),
  }
}

/** Delete the oldest calls across conversations until the folder holds at most `limit` bytes; returns bytes kept. */
export async function prune(home: string, limit = TOTAL_BYTES): Promise<number> {
  const root = folder(home)
  const files: { path: string; size: number; at: number }[] = []
  for (const conversation of await readdir(root).catch(missingAsEmpty)) {
    const dir = join(root, conversation)
    for (const n of await calls(dir)) {
      const path = join(dir, name(n))
      const info = await stat(path)
      files.push({ path, size: info.size, at: info.mtimeMs })
    }
  }
  let total = files.reduce((sum, file) => sum + file.size, 0)
  for (const file of files.toSorted((a, b) => a.at - b.at)) {
    if (total <= limit) break
    await drop(file.path)
    total -= file.size
  }
  return total
}
