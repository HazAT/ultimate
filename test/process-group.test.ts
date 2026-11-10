// fast-test-reason: child_process inspection is mocked; no subprocesses are started.
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { killProcessTree } from '@earendil-works/pi-claude-code/src/claude-cli.ts'
import { groupAlive, groupTarget } from '../lib/process-group.ts'

const platform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
  vi.restoreAllMocks()
  syncBuiltinESMExports()
})

// #562356: a test's fake Claude Code child had pid 1, and the provider's process.kill(-1, 'SIGKILL') ended the user's
// desktop session. test/no-group-signals.ts already keeps this file from signalling anything real.
it('never turns a pid that names no group into a group signal', () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
  expect(() => groupAlive(1)).toThrow('Not a process group')
  for (const pid of [1, 0, -1, -42, 1.5, Number.NaN]) {
    expect(() => groupTarget(pid)).toThrow('Not a process group')
    // Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/claude-cli.ts — killProcessTree ends such a child alone.
    const child = Object.assign(new EventEmitter(), {
      pid,
      exitCode: null,
      kill: vi.fn<(signal: string) => boolean>(),
    })
    killProcessTree(child as never)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  }
  expect(kill).not.toHaveBeenCalled()

  expect(groupTarget(42)).toBe(-42)
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    exitCode: null,
    kill: vi.fn<(signal: string) => boolean>(),
  })
  killProcessTree(child as never)
  expect(kill.mock.calls).toEqual([[-42, 'SIGKILL']])
  expect(child.kill).not.toHaveBeenCalled()
})

it('recognizes Darwin zombies beside unrelated unknown states without hiding a target permission failure', () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  const denied = Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw denied
  })
  const inspect = vi.spyOn(childProcess, 'execFileSync')
  syncBuiltinESMExports()
  for (const state of ['?', '?E']) {
    inspect.mockReturnValue(`  999 ${state}\n   42 Z\n`)
    expect(groupAlive(42)).toBe(false)

    inspect.mockReturnValue(`  999 Z\n   42 ${state}\n`)
    expect(() => groupAlive(42)).toThrow(denied)
  }
})
