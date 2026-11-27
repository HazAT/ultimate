import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { context } from '../../../server/harness.ts'
import * as processGroup from '../../../lib/process-group.ts'
import browserExtension from '../server.ts'

function makeMockBrowser(pid: number) {
  const page = {
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    on() {},
    addInitScript: async () => {},
    goto: async () => null,
    evaluate: async () => undefined,
    title: async () => 'Mock',
    url: () => 'data:text/html,ok',
  } as unknown as Page
  const closeContext = vi.fn<() => Promise<void>>(async () => {})
  const browserRef: { current?: Browser } = {}
  const mockContext = {
    on() {},
    newPage: async () => page,
    close: closeContext,
    browser: () => browserRef.current!,
    request: { get: async () => ({ ok: () => false, text: async () => '' }) },
  } as unknown as BrowserContext
  const closeBrowser = vi.fn<() => Promise<void>>(async () => {})
  const cdp = {
    send: async () => ({ processInfo: [{ type: 'browser', id: pid }] }),
    detach: async () => {},
  }
  const browser = {
    newBrowserCDPSession: async () => cdp,
    once() {},
    newContext: async () => mockContext,
    contexts: () => [],
    close: closeBrowser,
    isConnected: () => true,
  } as unknown as Browser
  browserRef.current = browser
  return { browser, closeBrowser, closeContext }
}

function makeHost() {
  const closers: (() => Promise<void>)[] = []
  const notices: string[] = []
  const host = {
    home: '/tmp/ultimate-browser-close-test',
    projectRoot: '/tmp/ultimate-browser-close-test',
    resource: <T>(_name: string, create: () => T) => create(),
    onClose: (close: () => Promise<void>) => closers.push(close),
    notice: (message: string) => notices.push(message),
    system: () => ({ process: { url: 'http://127.0.0.1:1/' } }),
    implement() {},
  } as unknown as ExtensionHost
  return { host, closers, notices }
}

const api = { output() {} } as unknown as ToolExecutionApi
const call = { url: 'data:text/html,ok', steps: [], screenshot: false }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubEnv('ULTIMATE_CHROMIUM', process.execPath)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('SIGKILLs the browser process group when browser.close() times out on relaunch or host close', async () => {
  const pid = 42424
  const start = 'boot-id:12345'
  const identify = vi.spyOn(processGroup, 'identify').mockReturnValue(start)
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

  const relaunchMock = makeMockBrowser(pid)
  relaunchMock.closeContext.mockRejectedValue(new Error('context wedged'))
  const hostCloseMock = makeMockBrowser(pid)
  vi.spyOn(chromium, 'launch')
    .mockResolvedValueOnce(relaunchMock.browser)
    .mockResolvedValueOnce(hostCloseMock.browser)

  const { host, closers, notices } = makeHost()
  const tool = browserExtension(host).tools!.find((t) => t.name === 'browser')!

  const relaunchCloseStarted = Promise.withResolvers<void>()
  relaunchMock.closeBrowser.mockImplementationOnce(() => {
    relaunchCloseStarted.resolve()
    return new Promise(() => {})
  })
  const relaunchCall = tool.execute(call, api, context)
  await relaunchCloseStarted.promise
  expect(kill).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(5_000)
  expect((await relaunchCall).isError).toBeFalsy()
  expect(kill).toHaveBeenCalledWith(-pid, 'SIGKILL')
  expect(notices.at(-1)).toContain('Closing the wedged browser failed')

  kill.mockClear()
  expect((await tool.execute(call, api, context)).isError).toBeFalsy()
  const hostCloseStarted = Promise.withResolvers<void>()
  hostCloseMock.closeBrowser.mockImplementationOnce(() => {
    hostCloseStarted.resolve()
    return new Promise(() => {})
  })
  const closing = Promise.all(closers.map((close) => close()))
  await hostCloseStarted.promise
  expect(kill).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(5_000)
  await closing
  expect(kill).toHaveBeenCalledWith(-pid, 'SIGKILL')
  expect(notices.at(-1)).toContain('Closing the browser failed')
  expect(identify).toHaveBeenCalledWith(pid)
})

it('does not SIGKILL a reused pid if the process identity changed before close timed out', async () => {
  const pid = 42425
  const identify = vi
    .spyOn(processGroup, 'identify')
    .mockReturnValueOnce('boot-id:original')
    .mockReturnValueOnce('boot-id:reused')
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
  const mock = makeMockBrowser(pid)
  mock.closeBrowser.mockReturnValue(new Promise(() => {}))
  vi.spyOn(chromium, 'launch').mockResolvedValueOnce(mock.browser)

  const { host, closers } = makeHost()
  const tool = browserExtension(host).tools!.find((t) => t.name === 'browser')!
  await tool.execute(call, api, context)

  const closing = Promise.all(closers.map((close) => close()))
  await vi.advanceTimersByTimeAsync(5_000)
  await closing
  expect(identify).toHaveBeenCalledTimes(2)
  expect(kill).not.toHaveBeenCalled()
})
