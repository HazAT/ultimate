import { mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { KEPT_MS } from '../extensions/attachments/limits.ts'
import { actions, sweep } from '../extensions/attachments/server.ts'
import type { ActionContext } from '../server/actions.ts'
import { splitAttachments, withAttachments } from '../web/src/app/attachments.ts'
import { removeTemp, temp } from './helpers.ts'

const cleanup: string[] = []
afterEach(async () => {
  for (const root of cleanup.splice(0)) await removeTemp(root)
})

async function context() {
  const home = await temp()
  cleanup.push(home)
  return { host: { home }, signal: new AbortController().signal } as unknown as ActionContext
}

it('stores an uploaded file under the home by its bare name and returns its path', async () => {
  const ctx = await context()
  const data = Buffer.from('%PDF-1.7 report').toString('base64')
  const { path } = await actions.upload({ name: '../../etc/re`port.pdf', data }, ctx)
  expect(dirname(dirname(path))).toBe(join(ctx.host.home, 'attachments'))
  expect(path.endsWith('/report.pdf')).toBe(true)
  expect(await readFile(path, 'utf8')).toBe('%PDF-1.7 report')
})

it('refuses a file over 8 MB', async () => {
  const data = Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64')
  await expect(actions.upload({ name: 'big.zip', data }, await context())).rejects.toThrow(
    'Files up to 8 MB attach',
  )
})

it('removes uploads older than 30 days and keeps newer ones', async () => {
  const { host } = await context()
  const now = Date.now()
  const old = `${now - KEPT_MS - 1}-aaaa`
  const fresh = `${now - 1000}-bbbb`
  for (const name of [old, fresh])
    await mkdir(join(host.home, 'attachments', name), { recursive: true })
  await sweep(host.home, now)
  expect(await readdir(join(host.home, 'attachments'))).toEqual([fresh])
})

it('references files in the prompt as lines the transcript reads back as chips', () => {
  const file = {
    name: 'report.pdf',
    size: '1.2 MB',
    mimeType: 'application/pdf',
    path: '/h/attachments/1-a/report.pdf',
  }
  const text = withAttachments('Summarise this', [file])
  expect(text).toBe(
    'Summarise this\n\nAttached file: `report.pdf` (1.2 MB, application/pdf) at `/h/attachments/1-a/report.pdf`',
  )
  expect(splitAttachments(text)).toEqual({ text: 'Summarise this', files: [file] })
  // A merged steer carries one input's lines in the middle.
  expect(splitAttachments(`${text}\nand also this`).files).toEqual([file])
})
