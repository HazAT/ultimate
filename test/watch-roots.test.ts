import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({ existsSync: () => true, watch: vi.fn<() => EventEmitter>() }))
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  ...fs,
}))

import { watchRoots } from '../server/watch-roots.ts'

it('reports a root watcher error and closes only the failed watcher', () => {
  const failing = Object.assign(new EventEmitter(), { close: vi.fn<() => void>() })
  const other = Object.assign(new EventEmitter(), { close: vi.fn<() => void>() })
  fs.watch.mockReturnValueOnce(failing).mockReturnValueOnce(other)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const stop = watchRoots(['/project/.ultimate', '/user/.ultimate'], vi.fn())
  try {
    const error = new Error('ENOSPC: inotify watch limit reached')
    failing.emit('error', error)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('/project'), error)
    expect(failing.close).toHaveBeenCalledOnce()
    expect(other.close).not.toHaveBeenCalled()
  } finally {
    stop()
    log.mockRestore()
  }
})
