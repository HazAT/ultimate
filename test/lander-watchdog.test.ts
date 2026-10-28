import { mkdir, mkdtemp, readdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { withAbortSignal } from '@earendil-works/chord/context'
import { afterEach, expect, it, vi } from 'vitest'
import { context } from '../server/harness.ts'
import { runGroup } from '../lib/process-group.ts'
import { projectSetup } from '../server/project-setup.ts'
import {
  landerSettings,
  limitsFor,
  runLanderCheck as run,
  untrustedLander,
} from '../extensions/workspaces/lander.ts'

vi.mock('../lib/process-group.ts', () => ({ runGroup: vi.fn<typeof runGroup>() }))
const runLanderCheck = (
  path: string,
  command: string,
  ctx: typeof context,
  limits?: Parameters<typeof run>[5],
) => run(path, command, ctx, tmpdir(), tmpdir(), limits)

afterEach(() => {
  vi.resetAllMocks()
  vi.useRealTimers()
})

/** A check that prints `line` every `outputEvery` ms until it is stopped, then exits from SIGKILL. */
function hanging(outputEvery?: number, line = 'progress\n') {
  vi.useFakeTimers()
  vi.mocked(runGroup).mockImplementation(async (_program, _args, options) => {
    const timer = outputEvery ? setInterval(() => options.onOutput(line), outputEvery) : undefined
    // Like runGroup, a signal that aborted before the start stops the run at once.
    if (!options.signal!.aborted)
      await new Promise<void>((resolve) =>
        options.signal!.addEventListener('abort', () => resolve(), { once: true }),
      )
    clearInterval(timer)
    return 137
  })
}

it('stops a silent check at the stall limit', async () => {
  hanging()
  const ran = runLanderCheck('.', 'sleep', context, { stall: 0.1, total: 0.3 })
  await vi.advanceTimersByTimeAsync(100)
  expect((await ran).failure).toContain('Stalled: no output for')
  expect(vi.getTimerCount()).toBe(0)
})

it('resets the stall timer on output but stops continuous output at the total limit', async () => {
  hanging(50)
  const ran = runLanderCheck('.', 'print', context, { stall: 0.1, total: 0.3 })
  await vi.advanceTimersByTimeAsync(300)
  expect((await ran).failure).toMatch(/^Timed out after 0.3 s\nprogress/)
  expect(vi.getTimerCount()).toBe(0)
})

it('defaults to a 2-minute stall and a 10-minute total cap', async () => {
  hanging()
  const silent = runLanderCheck('.', 'sleep', context)
  await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
  expect((await silent).failure).toBe('Stalled: no output for 2 min, stopped')
  hanging(60 * 1000)
  const printing = runLanderCheck('.', 'print', context)
  await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
  expect((await printing).failure).toMatch(/^Timed out after 10 min\nprogress/)
  expect(vi.getTimerCount()).toBe(0)
})

it('stops a printing check at its own timeout, not the default cap', async () => {
  hanging(10 * 1000)
  const limits = limitsFor({ command: 'pnpm test', timeout: 120 }, { stall: 120, total: 600 })
  expect(limits).toEqual({ stall: 120, total: 120 })
  const ran = runLanderCheck('.', 'pnpm test', context, limits)
  await vi.advanceTimersByTimeAsync(119 * 1000)
  expect(vi.getTimerCount()).toBeGreaterThan(0)
  await vi.advanceTimersByTimeAsync(1000)
  expect((await ran).failure).toMatch(/^Timed out after 2 min\n/)
  // A short timeout also caps the stall limit, and a check without one keeps the defaults.
  expect(limitsFor({ command: 'x', timeout: 30 }, { stall: 120, total: 600 })).toEqual({
    stall: 30,
    total: 30,
  })
  expect(limitsFor({ command: 'x' }, { stall: 120, total: 600 })).toEqual({
    stall: 120,
    total: 600,
  })
})

it('names the tests that failed before the watchdog fired, even when they left the tail', async () => {
  hanging(
    10,
    ' \u001b[31mFAIL\u001b[39m  test/cloud-lease.test.ts > hangs on a lease\n' +
      'noise\n'.repeat(600),
  )
  const ran = runLanderCheck('.', 'pnpm test', context, { stall: 1, total: 0.05 })
  await vi.advanceTimersByTimeAsync(50)
  const failure = (await ran).failure!
  expect(failure).toMatch(
    /^Timed out after 0.05 s\nFailed tests so far:\nFAIL {2}test\/cloud-lease.test.ts > hangs on a lease\nnoise/,
  )
  expect(failure.match(/FAIL/g)).toHaveLength(1)
})

it('names the failed tests of a check that exits nonzero', async () => {
  vi.mocked(runGroup).mockImplementation(async (_program, _args, options) => {
    options.onOutput(' × test/models.test.ts > falls back on logout 12ms\n' + 'noise\n'.repeat(600))
    return 1
  })
  const failure = (await runLanderCheck('.', 'pnpm test', context)).failure!
  expect(failure).toMatch(
    /^exit 1\nFailed tests:\n× test\/models.test.ts > falls back on logout 12ms\nnoise/,
  )
})

const settings = (checks: unknown) =>
  landerSettings({
    projectSettings: async () => ({ lander: { checks } }) as never,
  })

it('reads plain commands and commands with their own timeout from settings', async () => {
  expect(
    (
      await settings([
        'pnpm check',
        [{ command: 'pnpm test', timeout: 120 }, 'pnpm test:e2e'],
        { command: 'pnpm build', timeout: 60 },
      ])
    ).checks,
  ).toEqual([
    { command: 'pnpm check' },
    [{ command: 'pnpm test', timeout: 120 }, { command: 'pnpm test:e2e' }],
    { command: 'pnpm build', timeout: 60 },
  ])
  for (const invalid of [
    [{ command: 'pnpm test', timeout: 0 }],
    [{ command: 'pnpm test', timeout: '2m' }],
    [{ timeout: 60 }],
    [[]],
    'pnpm test',
  ])
    await expect(settings(invalid)).rejects.toThrow('lander.checks must be')
})

it('refuses lander settings an untrusted project setup would skip', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'lander-trust-')))
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  const host = { projectRoot, projectSetup: () => projectSetup(projectRoot, home) }
  const declare = (lander: unknown) =>
    writeFile(join(projectRoot, '.ultimate/settings.json'), JSON.stringify({ lander }))
  const trust = async (decision: boolean) => {
    await mkdir(join(home, '.ultimate'), { recursive: true })
    await writeFile(join(home, '.ultimate/trust.json'), JSON.stringify({ [projectRoot]: decision }))
  }

  expect(await untrustedLander(host)).toBeUndefined()
  await declare({ checks: [] })
  expect(await untrustedLander(host)).toBeUndefined()
  await declare({ checks: ['pnpm check'], push: 'origin' })
  expect(await untrustedLander(host)).toBe(
    "this project's setup is not chosen yet, so the lander checks and push that .ultimate/settings.json declares would not run",
  )
  await trust(false)
  expect(await untrustedLander(host)).toMatch(/^this project's setup is turned off/)
  await trust(true)
  expect(await untrustedLander(host)).toBeUndefined()
})

it('preserves task cancellation instead of reporting a watchdog failure', async () => {
  hanging()
  const controller = new AbortController()
  const ran = runLanderCheck('.', 'sleep', withAbortSignal(controller.signal, context))
  controller.abort(new Error('task cancelled'))
  await expect(ran).rejects.toThrow('task cancelled')
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps successful summaries and clears both timers', async () => {
  vi.useFakeTimers()
  vi.mocked(runGroup).mockImplementation(async (_program, _args, options) => {
    options.onOutput('first\nlast\n')
    return 0
  })
  expect(await runLanderCheck('.', 'print', context)).toEqual({ summary: 'last' })
  expect(vi.getTimerCount()).toBe(0)
})

it('gives each check its own TMPDIR in the given directory and removes it afterwards', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'lander-tmp-'))
  let seen: string | undefined
  vi.mocked(runGroup).mockImplementation(async (_program, _args, options) => {
    seen = options.env?.TMPDIR
    await writeFile(join(seen!, 'left'), '')
    return 1
  })
  await run('.', 'pnpm test', context, tmpdir(), temp)
  expect(seen && dirname(seen)).toBe(temp)
  expect(await readdir(temp)).toEqual([])
})
