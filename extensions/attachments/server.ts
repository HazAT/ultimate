import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { KEPT_MS, MAX_FILE_BYTES } from './limits.ts'
import { UploadAction } from './refs.ts'

/** Where uploads live: the project's home, outside every checkout, so a file never blocks a landing. */
const folder = (home: string) => join(home, 'attachments')

/** A file name safe to store and to quote in a prompt line: its last segment, without control characters or backticks. */
export function safeName(name: string) {
  const cleaned = basename(name.replaceAll('\\', '/'))
    // oxlint-disable-next-line no-control-regex -- Control characters are what this strips.
    .replace(/[\u0000-\u001f\u007f`]/g, '')
    .trim()
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned.slice(0, 200) : 'file'
}

/** Delete uploads older than `KEPT_MS`: each folder's name starts with its upload time in ms. */
export async function sweep(home: string, now = Date.now()) {
  const names = await readdir(folder(home)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const name of names) {
    const at = Number(/^(\d{13})-/.exec(name)?.[1])
    if (at && now - at > KEPT_MS)
      await rm(join(folder(home), name), { recursive: true, force: true })
  }
}

export default function attachments(host: Pick<ExtensionHost, 'home' | 'onOpen' | 'notice'>) {
  host.onOpen(async () => {
    await sweep(host.home).catch((error: unknown) => {
      host.notice(`Attachments cleanup failed: ${String(error)}`)
    })
  })
  return { name: 'attachments' }
}

export const actions = {
  /** `{ name, data }`: a file the composer attached, as base64; stored under a fresh folder, its path returned. */
  upload: implementAction(UploadAction, async (args, { host }) => {
    const { name, data } = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    if (typeof name !== 'string' || typeof data !== 'string')
      throw new Error('Expected { name, data: base64 }')
    const bytes = Buffer.from(data, 'base64')
    if (bytes.byteLength > MAX_FILE_BYTES)
      throw new Error(`Files up to ${MAX_FILE_BYTES / 1024 / 1024} MB attach`)
    const dir = join(folder(host.home), `${Date.now()}-${randomUUID().slice(0, 8)}`)
    await mkdir(dir, { recursive: true })
    const path = join(dir, safeName(name))
    await writeFile(path, bytes)
    return { path }
  }),
}
