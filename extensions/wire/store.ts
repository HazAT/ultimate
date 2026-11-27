import type { ConversationId } from '@earendil-works/pi-durable'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { settled } from '../../lib/errors.shared.ts'
import type { WireCall, WireSummary } from './refs.ts'

export const PER_CONVERSATION = 20
export const TOTAL_BYTES = 300 * 1024 * 1024

export const folder = (home: string) => join(home, 'wire')
const listedCallFileName = (n: number) => `${String(n).padStart(8, '0')}.json.gz`
const summaryName = (n: number) => `${String(n).padStart(8, '0')}.summary.json`
const removeCallBeforeSummary = async (dir: string, n: number) => {
  await rm(join(dir, listedCallFileName(n)), { force: true })
  await rm(join(dir, summaryName(n)), { force: true })
}
const numberOf = (file: string) => Number(/^(\d{8})\.json\.gz$/.exec(file)?.[1] ?? NaN)

const missingAsEmpty = (error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return []
  throw error
}

async function listedCallNumbers(dir: string): Promise<number[]> {
  const files = await readdir(dir).catch(missingAsEmpty)
  return files
    .map(numberOf)
    .filter(Number.isFinite)
    .toSorted((a, b) => a - b)
}

export type Queue = { tail: Promise<unknown> }

export function save(queue: Queue, home: string, call: Omit<WireCall, 'n'>): Promise<number> {
  const dir = join(folder(home), String(call.conversationId))
  const run = settled(queue.tail).then(async () => {
    await mkdir(dir, { recursive: true })
    const existing = await listedCallNumbers(dir)
    const n = (existing.at(-1) ?? 0) + 1
    const summaryBeforeListedCall = JSON.stringify(summarize({ ...call, n }))
    await writeFile(join(dir, summaryName(n)), summaryBeforeListedCall)
    await writeFile(join(dir, listedCallFileName(n)), gzipSync(JSON.stringify({ ...call, n })))
    for (const old of existing.slice(0, Math.max(0, existing.length + 1 - PER_CONVERSATION)))
      await removeCallBeforeSummary(dir, old)
    await prune(home)
    return n
  })
  queue.tail = run
  return run
}

export async function load(
  home: string,
  conversationId: ConversationId,
  n: number,
): Promise<WireCall | undefined> {
  const bytes = await readFile(
    join(folder(home), String(conversationId), listedCallFileName(n)),
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  return bytes && (JSON.parse(gunzipSync(bytes).toString('utf8')) as WireCall)
}

export async function list(home: string, conversationId: ConversationId): Promise<WireSummary[]> {
  const dir = join(folder(home), String(conversationId))
  const summaries = await Promise.all(
    (await listedCallNumbers(dir)).map((n) =>
      readFile(join(dir, summaryName(n)), 'utf8').then(
        (text) => JSON.parse(text) as WireSummary,
        (error: NodeJS.ErrnoException) => {
          const callWasPrunedDuringListing = error.code === 'ENOENT'
          if (callWasPrunedDuringListing) return undefined
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

export async function prune(home: string, limit = TOTAL_BYTES): Promise<number> {
  const root = folder(home)
  const kept: { dir: string; n: number; size: number; at: number }[] = []
  for (const conversation of await readdir(root).catch(missingAsEmpty)) {
    const dir = join(root, conversation)
    for (const n of await listedCallNumbers(dir)) {
      const [file, summary] = await Promise.all([
        stat(join(dir, listedCallFileName(n))),
        stat(join(dir, summaryName(n))),
      ])
      kept.push({ dir, n, size: file.size + summary.size, at: file.mtimeMs })
    }
  }
  let total = kept.reduce((sum, call) => sum + call.size, 0)
  for (const call of kept.toSorted((a, b) => a.at - b.at)) {
    if (total <= limit) break
    await removeCallBeforeSummary(call.dir, call.n)
    total -= call.size
  }
  return total
}
