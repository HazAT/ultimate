import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { exec } from '../../../lib/exec.ts'
import { loadable } from '../server.ts'

vi.mock('../../../lib/exec.ts', () => ({ exec: vi.fn<typeof exec>() }))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readFile: vi.fn<() => Promise<string>>(async () => 'lockfileVersion: 9\n'),
}))

afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

it('waits while index.lock exists and resolves only after its removal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ultimate-update-loadable-'))
  const index = join(root, 'index.lock')
  writeFileSync(index, '')
  vi.mocked(exec).mockResolvedValue({ stdout: index, stderr: '' })
  const host = {
    ultimateRoot: root,
    resource: (_name: string, create: () => unknown) => create(),
  } as unknown as ExtensionHost
  vi.useFakeTimers()
  const resolved = vi.fn<() => void>()
  const loading = loadable(host).then(resolved)
  try {
    await vi.advanceTimersByTimeAsync(100)
    expect(resolved).not.toHaveBeenCalled()
    unlinkSync(index)
    await vi.advanceTimersByTimeAsync(50)
    await loading
    expect(resolved).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
    await vi.runAllTimersAsync()
    await loading
  }
})
