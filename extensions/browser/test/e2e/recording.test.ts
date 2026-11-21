import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { browserVideoOf } from '../../../../lib/browser-video.ts'
import type { ExtensionHost } from '../../../../server/extensions.ts'
import { context } from '../../../../server/harness.ts'
import { removeTemp, temp } from '../../../../test/helpers.ts'
import browserExtension from '../../server.ts'

it('publishes only successful recordings, with the browser step outcomes and private file modes', async () => {
  const home = await temp('ultimate-browser-recording-')
  const closers: (() => Promise<void>)[] = []
  const host = {
    home,
    projectRoot: home,
    resource: <T>(_name: string, create: () => T) => create(),
    onClose: (close: () => Promise<void>) => closers.push(close),
    system: () => ({ process: { url: 'http://127.0.0.1:1/' } }),
  } as unknown as ExtensionHost
  const tools = new Map(browserExtension(host).tools!.map((tool) => [tool.name, tool]))
  const browser = tools.get('browser')!
  const record = tools.get('browser_video')!
  const root = join(home, 'browser-videos')
  const url = `data:text/html,${encodeURIComponent('<title>Demo</title><button onclick="this.textContent = \'Done\'">Start</button>')}`
  const steps = [{ click: 'button' }, { eval: 'document.querySelector("button").textContent' }]
  const api = { output() {} } as unknown as ToolExecutionApi
  try {
    expect(
      (await browser.execute({ url, steps, screenshot: false }, api, context)).isError,
    ).toBeFalsy()
    expect(await readdir(home)).toEqual([])

    const result = await record.execute({ url, steps, synthetic: true }, api, context)
    expect(result.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('Step 2: OK "Done"') }),
      ]),
    )
    const clip = browserVideoOf(result.details)
    expect(clip).toEqual({ id: expect.any(String), title: 'Demo' })
    expect(browserVideoOf((result as { structuredContent?: unknown }).structuredContent)).toEqual(
      clip,
    )
    const directory = join(root, clip!.id)
    const video = join(directory, 'video.webm')
    expect(await readdir(directory)).toEqual(['video.webm'])
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(video)).mode & 0o777).toBe(0o600)

    const failure = await record.execute(
      { url, steps: [{ eval: 'window.missing()' }], synthetic: true },
      api,
      context,
    )
    expect(failure.isError).toBe(true)
    expect(failure.details).toBeUndefined()
    expect(await readdir(root)).toEqual([clip!.id])

    const controller = new AbortController()
    const abortingApi = {
      ...api,
      output(text: string) {
        if (text.startsWith('Step 1:')) controller.abort()
      },
    }
    const aborted = await record.execute({ url, steps, synthetic: true }, abortingApi, {
      ...context,
      abortSignal: controller.signal,
    })
    expect(aborted.isError).toBe(true)
    expect(aborted.details).toBeUndefined()
    expect(await readdir(root)).toEqual([clip!.id])
  } finally {
    for (const close of closers) await close()
    await removeTemp(home)
  }
})
