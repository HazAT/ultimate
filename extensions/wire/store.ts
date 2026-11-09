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
/** A call's file goes first: a call is listed by its file, so the summary left a moment longer is never missed. */
const drop = async (dir: string, n: number) => {
  await rm(join(dir, name(n)), { force: true })
  await rm(join(dir, summaryName(n)), { force: true })
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

/**
 * The tail of the write queue. The caller keeps it in a resource that outlives facet reloads, so the old and new
 * code never write at once: call numbers never collide and pruning never races a write.
 */
export type Queue = { tail: Promise<unknown> }

/**
 * Store `call` as its conversation's next one, drop the conversation's calls past the window and keep the folder
 * under `TOTAL_BYTES`; returns its number.
 */
export function save(queue: Queue, home: string, call: Omit<WireCall, 'n'>): Promise<number> {
  const dir = join(folder(home), String(call.conversationId))
  const run = queue.tail
    .catch(() => {
      // The previous write's caller got its failure; this one still runs.
    })
    .then(async () => {
      await mkdir(dir, { recursive: true })
      const existing = await calls(dir)
      const n = (existing.at(-1) ?? 0) + 1
      // The summary goes first: a call is listed by its file, which then always has one.
      await writeFile(join(dir, summaryName(n)), JSON.stringify(summarize({ ...call, n })))
      await writeFile(join(dir, name(n)), gzipSync(JSON.stringify({ ...call, n })))
      for (const old of existing.slice(0, Math.max(0, existing.length + 1 - PER_CONVERSATION)))
        await drop(dir, old)
      await prune(home)
      return n
    })
  queue.tail = run
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
  const summaries = await Promise.all(
    (await calls(dir)).map((n) =>
      readFile(join(dir, summaryName(n)), 'utf8').then(
        (text) => JSON.parse(text) as WireSummary,
        (error: NodeJS.ErrnoException) => {
          // Pruned between the directory read and this one: the call is gone, so it is not listed.
          if (error.code === 'ENOENT') return undefined
          throw error
        },
      ),
    ),
  )
  return summaries.filter((summary) => summary !== undefined)
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
  const kept: { dir: string; n: number; size: number; at: number }[] = []
  for (const conversation of await readdir(root).catch(missingAsEmpty)) {
    const dir = join(root, conversation)
    for (const n of await calls(dir)) {
      const [file, summary] = await Promise.all([
        stat(join(dir, name(n))),
        stat(join(dir, summaryName(n))),
      ])
      kept.push({ dir, n, size: file.size + summary.size, at: file.mtimeMs })
    }
  }
  let total = kept.reduce((sum, call) => sum + call.size, 0)
  for (const call of kept.toSorted((a, b) => a.at - b.at)) {
    if (total <= limit) break
    await drop(call.dir, call.n)
    total -= call.size
  }
  return total
}
