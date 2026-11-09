import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { createBashTool } from '@earendil-works/pi-durable/tools'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import codingTools from '../server.ts'
import { context } from '../../../server/harness.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'

afterEach(() => vi.unstubAllEnvs())

it('uses a 600-second default tripwire and leaves explicit timeouts unchanged', async () => {
  vi.stubEnv('ULTIMATE_BASH_TIMEOUT', undefined)
  const execute = vi
    .fn<ReturnType<typeof createBashTool>['execute']>()
    .mockRejectedValue(new Error('Command timed out after 600 seconds'))
  const wrapper = codingTools({
    emit: vi.fn<ExtensionHost['emit']>() as ExtensionHost['emit'],
  }).wraps!.find((wrap) => 'tool' in wrap && wrap.tool === 'bash')!
  if (!('tool' in wrapper)) throw new Error('Missing bash wrapper')
  const bash = wrapper.wrap({ ...createBashTool(), execute })
  const api = {} as ToolExecutionApi
  await expect(bash.execute({ command: 'sleep' }, api, context)).rejects.toThrow(
    'Tripwire: bash ran past the 600 s default limit',
  )
  expect(execute.mock.calls[0][0]).toEqual({ command: 'sleep', timeout: 600 })
  await expect(bash.execute({ command: 'sleep', timeout: 1200 }, api, context)).rejects.toThrow(
    'Command timed out after 600 seconds',
  )
  expect(execute.mock.calls[1][0]).toEqual({ command: 'sleep', timeout: 1200 })
  vi.stubEnv('ULTIMATE_BASH_TIMEOUT', '42')
  await expect(bash.execute({ command: 'sleep' }, api, context)).rejects.toThrow(
    'the 42 s default limit',
  )
  expect(execute.mock.calls[2][0]).toEqual({ command: 'sleep', timeout: 42 })
})

/** A grey 8-bit grayscale PNG of `width`x`height`. */
function png(width: number, height: number) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth; colour type 0 (grayscale), default compression, filter and interlace
  const rows = Buffer.alloc((width + 1) * height, 128)
  for (let row = 0; row < height; row++) rows[row * (width + 1)] = 0 // filter: none
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

it('reads an image past the 2000 px limit shrunk to fit, keeping its aspect ratio', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ultimate-read-'))
  try {
    await writeFile(join(dir, 'wide.png'), png(3000, 30))
    const read = codingTools({
      emit: vi.fn<ExtensionHost['emit']>() as ExtensionHost['emit'],
    }).tools!.find((tool) => tool.name === 'read')!
    const api = {
      env: new NodeExecutionEnv({ cwd: dir }),
      agent: async () => ({}),
    } as unknown as ToolExecutionApi
    const result = await read.execute({ path: 'wide.png' }, api, context)
    expect(result.isError).toBeFalsy()
    expect(result.output).toEqual([
      expect.objectContaining({ type: 'image', mimeType: 'image/png' }),
    ])
    expect(result.diagnostics?.[0].message).toContain(
      'Resized from 3000x30 to 2000x20. Multiply coordinates by 1.50',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
