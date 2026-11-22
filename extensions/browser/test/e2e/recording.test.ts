import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import {
  createRegistry,
  defineExtension,
  Harness,
  hook,
  MemoryStorage,
  ToolTask,
  type JsonObject,
  type ToolExecutionApi,
  type ToolHooks,
} from '@earendil-works/pi-durable'
import { expect, it, onTestFinished, vi } from 'vitest'
import { browserVideoOf, type BrowserClip } from '../../../../lib/browser-video.ts'
import type { ExtensionHost } from '../../../../server/extensions.ts'
import { context } from '../../../../server/harness.ts'
import { removeTemp, temp, until } from '../../../../test/helpers.ts'
import { BrowserRecordings } from '../../api.ts'
import browserExtension, { files } from '../../server.ts'

const url = `data:text/html,${encodeURIComponent('<title>Demo</title><button onclick="this.textContent = \'Done\'">Start</button>')}`
const steps: JsonObject[] = [
  { click: 'button' },
  { eval: 'document.querySelector("button").textContent' },
]

async function fixture(afterTool?: ToolHooks['afterTool']) {
  const home = await temp('ultimate-browser-recording-')
  const closers: (() => Promise<void>)[] = []
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context)
  onTestFinished(async () => {
    await harness.close(context)
    for (const close of closers) await close()
    await removeTemp(home)
  })
  const implement = vi.fn<ExtensionHost['implement']>()
  const host = {
    home,
    projectRoot: home,
    implement,
    harness: () => harness,
    resource: <T>(_name: string, create: () => T) => create(),
    onClose: (close: () => Promise<void>) => closers.push(close),
    system: () => ({ process: { url: 'http://127.0.0.1:1/' } }),
  } as unknown as ExtensionHost
  const extension = browserExtension(host)
  const [token, recordings] = implement.mock.calls[0]
  expect(token).toBe(BrowserRecordings)
  const service = recordings as NonNullable<typeof BrowserRecordings.service>
  registry.install(extension)
  if (afterTool)
    registry.install(
      defineExtension({ name: 'hold-recording', hooks: [hook(ToolTask, { afterTool })] }),
    )
  const model = faux.getModel()
  const root = await harness.root(context, {
    agent: { model: { provider: model.provider, modelId: model.id } },
  })
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('browser_video', { url, steps, synthetic: true }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('Done'),
  ])
  const result = async () => {
    const entries = (await root.context(context)).entries
    return entries
      .findLast((entry) => entry.kind === 'pi.tool-result')
      ?.model?.find((message) => message.role === 'toolResult')
  }
  return {
    home,
    root,
    tools: new Map(extension.tools!.map((tool) => [tool.name, tool])),
    recordings: join(home, 'browser-videos'),
    open: (id: string) => files(id, 'video', { host }),
    find: (id: string) => service.find(id, context),
    result,
  }
}

it('publishes only successful recordings, with the browser step outcomes and private file modes', async () => {
  const f = await fixture()
  const api = { output() {} } as unknown as ToolExecutionApi
  const browser = f.tools.get('browser')!
  expect(
    (await browser.execute({ url, steps, screenshot: false }, api, context)).isError,
  ).toBeFalsy()
  expect(await readdir(f.home)).toEqual([])

  await (await f.root.submit({ type: 'input', content: 'Record the demo' }, context)).wait(context)
  const result = await f.result()
  expect(result?.isError).toBe(false)
  expect(result?.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining('Step 2: OK "Done"') }),
    ]),
  )
  const clip = browserVideoOf(result?.details)
  expect(clip).toEqual({ id: expect.any(String), title: 'Demo' })
  const id = clip!.id
  const directory = join(f.recordings, id)
  expect(await f.find(id)).toEqual({ ...clip, conversation: f.root.id })
  const opened = await f.open(id)
  expect(opened?.type).toBe('video/webm')
  await opened?.file.close()
  expect((await stat(f.recordings)).mode & 0o777).toBe(0o700)
  expect((await stat(directory)).mode & 0o777).toBe(0o700)
  const names = (await readdir(directory)).toSorted()
  expect(names).toEqual(['receipt.json', 'video.webm'])
  for (const name of names) expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600)

  const record = f.tools.get('browser_video')!
  const failure = await record.execute(
    { url, steps: [{ eval: 'window.missing()' }], synthetic: true },
    api,
    context,
  )
  expect(failure.isError).toBe(true)
  expect(failure.details).toBeUndefined()
  expect(await readdir(f.recordings)).toEqual([id])

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
  expect(await readdir(f.recordings)).toEqual([id])
})

it('keeps a finalized WebM private before the tool result commits and removes it on a late abort', async () => {
  const gate = Promise.withResolvers<void>()
  let pending: BrowserClip | undefined
  const f = await fixture(async (call, result, _api, ctx) => {
    if (call.name !== 'browser_video' || result.isError) return
    pending = browserVideoOf(result.details)
    ctx.abortSignal!.throwIfAborted()
    ctx.abortSignal!.addEventListener('abort', () => gate.resolve(), { once: true })
    await gate.promise
    ctx.abortSignal!.throwIfAborted()
  })
  try {
    const submitted = await f.root.submit({ type: 'input', content: 'Record the demo' }, context)
    await until(() => !!pending)
    const id = pending!.id
    expect(await f.result()).toBeUndefined()
    expect((await stat(join(f.recordings, id, 'video.webm'))).size).toBeGreaterThan(0)
    expect(await f.open(id)).toBeUndefined()
    expect(await f.find(id)).toBeUndefined()

    await f.root.abort(context)
    await submitted.wait(context)
    const aborted = await f.result()
    expect(aborted?.isError).toBe(true)
    expect(aborted?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining('Tool browser_video was aborted'),
        }),
      ]),
    )
    expect(await readdir(f.recordings)).toEqual([])
    expect(await f.open(id)).toBeUndefined()
    expect(await f.find(id)).toBeUndefined()
  } finally {
    gate.resolve()
  }
})
