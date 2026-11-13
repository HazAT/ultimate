import { access, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { expect, it, vi } from 'vitest'
import { context } from '../../../../server/harness.ts'
import browserExtension, { browserBinary } from '../../server.ts'
import type { ExtensionHost } from '../../../../server/extensions.ts'
import { groupAlive } from '../../../../lib/process-group.ts'
import { removeTemp, temp, until } from '../../../../test/helpers.ts'

// A managed Mac's Chrome dropped its CDP pipe seconds after each first page and kept running; every call launched
// another one, each failed context close raised a notice, and the dropped browsers piled up until the host exited.
it('kills a browser that drops its connection and keeps running, without a notice', async () => {
  const directory = await temp('ultimate-browser-dropped-')
  const pidFile = join(directory, 'chrome.pid')
  vi.stubEnv('ULTIMATE_CHROMIUM', resolve('extensions/browser/test/e2e/dropping-chrome.ts'))
  vi.stubEnv('DROPPING_CHROME_PID', pidFile)
  const closers: (() => Promise<void>)[] = []
  const notices: string[] = []
  const host = {
    home: join(directory, 'home'),
    projectRoot: directory,
    resource: <T>(_name: string, create: () => T) => create(),
    onClose: (close: () => Promise<void>) => closers.push(close),
    notice: (message: string) => notices.push(message),
    system: () => ({ process: { url: 'http://127.0.0.1:1/' } }),
  } as unknown as ExtensionHost
  const screenshot = browserExtension(host).tools!.find((tool) => tool.name === 'screenshot')!
  const api = { output() {} } as unknown as ToolExecutionApi
  let pid: number | undefined
  try {
    const result = await screenshot.execute({ url: 'data:text/html,x' }, api, context)
    expect(result.isError).toBe(true)
    pid = Number(await readFile(pidFile, 'utf8'))
    await until(() => !groupAlive(pid))
    expect(notices).toEqual([])
  } finally {
    if (pid && groupAlive(pid)) process.kill(-pid, 'SIGKILL')
    vi.unstubAllEnvs()
    for (const close of closers) await close()
    await removeTemp(directory)
  }
})

it('times out a hung step, closes its page and keeps later calls working', async () => {
  const directory = await temp('ultimate-browser-timeout-')
  // Under load a cold launch outlasted the call's 1 s timeoutMs and failed it before its first step.
  // A launch slower than timeoutMs keeps that deterministic.
  const slowChrome = join(directory, 'slow-chrome')
  await writeFile(slowChrome, `#!/bin/sh\nsleep 1.5\nexec '${await browserBinary()}' "$@"\n`, {
    mode: 0o755,
  })
  vi.stubEnv('ULTIMATE_CHROMIUM', slowChrome)
  const closers: (() => Promise<void>)[] = []
  const notices: string[] = []
  const host = {
    home: join(directory, 'home'),
    projectRoot: directory,
    resource: <T>(_name: string, create: () => T) => create(),
    onClose: (close: () => Promise<void>) => closers.push(close),
    notice: (message: string) => notices.push(message),
    system: () => ({ process: { url: 'http://127.0.0.1:1/' } }),
  } as unknown as ExtensionHost
  const browser = browserExtension(host).tools!.find((tool) => tool.name === 'browser')!
  const api = { output() {} } as unknown as ToolExecutionApi
  const url = 'data:text/html,<title>Hang</title>'
  const drive = async (steps: unknown[], timeoutMs?: number) => {
    const started = Date.now()
    const result = await browser.execute({ url, steps, screenshot: false, timeoutMs }, api, context)
    return { result, text: JSON.stringify(result.output), ms: Date.now() - started }
  }
  try {
    for (const hang of ['new Promise(() => {})', 'for (;;) {}']) {
      const hung = await drive([{ eval: '1 + 1' }, { eval: hang }], 1000)
      expect(hung.result.isError).toBe(true)
      expect(hung.text).toContain('Step 1: OK 2')
      expect(hung.text).toContain('Step 2: TimeoutError: timed out after 1s')
      expect(hung.ms).toBeLessThan(15_000)
      const next = await drive([{ eval: 'document.title' }])
      expect(next.result.isError).toBeFalsy()
      expect(next.text).toContain('Step 1: OK \\"Hang\\"')
    }
  } finally {
    vi.unstubAllEnvs()
    for (const close of closers) await close()
    await removeTemp(directory)
  }
})

it('saves screenshots at the given path, relative to the conversation cwd, creating parents', async () => {
  const directory = await temp('ultimate-browser-path-')
  const closers: (() => Promise<void>)[] = []
  const host = {
    home: join(directory, 'home'),
    projectRoot: join(directory, 'project'),
    resource: <T>(_name: string, create: () => T) => create(),
    onClose: (close: () => Promise<void>) => closers.push(close),
    system: () => ({ process: { url: 'http://127.0.0.1:1/' } }),
  } as unknown as ExtensionHost
  const tools = new Map(browserExtension(host).tools!.map((tool) => [tool.name, tool]))
  const cwd = join(directory, 'worktree')
  const api = (env = true) =>
    ({ env: env ? { cwd } : undefined, output() {} }) as unknown as ToolExecutionApi
  const url = 'data:text/html,<title>Shot</title><p>hello</p>'
  const file = async (name: string, args: Record<string, unknown>, env?: boolean) => {
    const result = await tools.get(name)!.execute({ url, waitMs: 0, ...args }, api(env), context)
    expect(result.isError).toBeFalsy()
    // Codemode reads this structured result; the model reads the PNG line of the output.
    const saved = (result as { structuredContent?: { file: string } }).structuredContent!.file
    await access(saved)
    expect(JSON.stringify(result.output)).toContain(`PNG: ${saved}`)
    return saved
  }
  try {
    expect(await file('screenshot', { path: join(directory, 'a/b/absolute.png') })).toBe(
      join(directory, 'a/b/absolute.png'),
    )
    expect(await file('screenshot', { path: 'shots/new/relative.png' })).toBe(
      join(cwd, 'shots/new/relative.png'),
    )
    expect(await file('browser', { path: 'steps/browser.png', steps: [] })).toBe(
      join(cwd, 'steps/browser.png'),
    )
    expect(await file('screenshot', { path: 'no-env.png' }, false)).toBe(
      join(host.projectRoot, 'no-env.png'),
    )
    expect(await file('screenshot', {})).toMatch(new RegExp(`^${host.home}/screenshots/.+\\.png$`))
    const wrong = await tools
      .get('screenshot')!
      .execute({ path: '/?conversation=1' }, api(), context)
    expect(wrong.isError).toBe(true)
    expect(JSON.stringify(wrong.output)).toContain('must end in .png')
  } finally {
    for (const close of closers) await close()
    await removeTemp(directory)
  }
})
