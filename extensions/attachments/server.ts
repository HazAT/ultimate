import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { KEPT_MS, MAX_FILE_BYTES_FOR_12_MB_ACTION } from './limits.shared.ts'
import { UploadAction } from './refs.ts'

const uploadsOutsideCheckout = (home: string) => join(home, 'attachments')

export function safeName(name: string) {
  const cleaned = basename(name.replaceAll('\\', '/'))
    .replace(/(?![\u0080-\u009f])[\p{Cc}`]/gu, '')
    .trim()
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned.slice(0, 200) : 'file'
}

export async function sweep(home: string, now = Date.now()) {
  const names = await readdir(uploadsOutsideCheckout(home)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    },
  )
  for (const name of names) {
    const uploadedAtMs = Number(/^(\d{13})-/.exec(name)?.[1])
    if (uploadedAtMs && now - uploadedAtMs > KEPT_MS)
      await rm(join(uploadsOutsideCheckout(home), name), { recursive: true, force: true })
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
  upload: implementAction(UploadAction, async (args, { host }) => {
    const { name, data } = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    if (typeof name !== 'string' || typeof data !== 'string')
      throw new Error('Expected { name, data: base64 }')
    const bytes = Buffer.from(data, 'base64')
    if (bytes.byteLength > MAX_FILE_BYTES_FOR_12_MB_ACTION)
      throw new Error(`Files up to ${MAX_FILE_BYTES_FOR_12_MB_ACTION / 1024 / 1024} MB attach`)
    const dir = join(uploadsOutsideCheckout(host.home), `${Date.now()}-${randomUUID().slice(0, 8)}`)
    await mkdir(dir, { recursive: true })
    const path = join(dir, safeName(name))
    await writeFile(path, bytes)
    return { path }
  }),
}
