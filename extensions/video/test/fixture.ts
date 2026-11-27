import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../../server/actions.ts'
import { context, prepareHarness } from '../../../server/harness.ts'
import type { OpenHost } from '../../../server/harness.ts'
import { apis, eventHost, openers, temp, createTestExtensionHost } from '../../../test/helpers.ts'
import { VideoApi } from '../api.ts'
import { GEMINI } from '../gemini.ts'
import type { Runner } from '../prepare.ts'
import videoExtension, { actions, docs } from '../server.ts'

const opened = new Set<OpenHost>()
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const host of opened) await host.close()
  opened.clear()
})

export type Call = { method: string; path: string; headers: Headers; body?: string }
export type Fake = (call: Call) => Response | Promise<Response>

export const gemini = (status: number, body: unknown, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers })

export async function fixture(run: Runner, fake?: Fake) {
  vi.stubEnv('GEMINI_API_KEY', undefined)
  const home = await temp('ultimate-video-')
  const prepared = await prepareHarness({ home, ultimateRoot: home, userHome: home })
  await mkdir(join(home, '.ultimate'), { recursive: true })
  if (fake)
    await writeFile(
      join(home, '.ultimate/secrets.json'),
      JSON.stringify({ secrets: { GEMINI_API_KEY: { value: 'test-key', updatedAt: '' } } }),
      { mode: 0o600 },
    )
  const calls: Call[] = []
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url)
    const call: Call = {
      method: init?.method ?? 'GET',
      path: href.startsWith(GEMINI) ? href.slice(GEMINI.length) : href,
      headers: new Headers(init?.headers),
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      ...(init?.body instanceof Blob ? { body: await init.body.text() } : {}),
    }
    calls.push(call)
    return fake!(call)
  }) as typeof globalThis.fetch
  const services = apis()
  const lifecycle = openers()
  let current: OpenHost
  const harness = () => current.harness
  const events = eventHost(harness, 'video')
  const resources = new Map<string, unknown>()
  const host = createTestExtensionHost({
    ...prepared,
    ...services,
    ...events,
    harness,
    onOpen: lifecycle.onOpen,
    notice: (message: string) => {
      throw new Error(message)
    },
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key)
    },
  })
  prepared.registry.install(videoExtension(host, run, { fetch, pollMs: 0 }))
  const open = async () => {
    current = await prepared.open(false)
    opened.add(current)
    await lifecycle.open()
    harness().resume()
  }
  const close = async () => {
    await lifecycle.close()
    await current.close()
    opened.delete(current)
  }
  await open()
  const action = {
    host,
    conversationId: ROOT_CONVERSATION_ID,
    signal: new AbortController().signal,
  } as ActionContext
  const state = () => harness().snapshot(docs[0], ROOT_CONVERSATION_ID, context)
  return {
    home,
    calls,
    action,
    open,
    close,
    harness,
    state,
    recent: events.eventLog.recent,
    service: services.need(VideoApi),
    async upload(bytes: Buffer) {
      const { id } = await actions.begin(
        { name: 'clip.mp4', mimeType: 'video/mp4', bytes: bytes.length },
        action,
      )
      await actions.append({ id, offset: 0, data: bytes.toString('base64') }, action)
      await actions.finish({ id }, action)
      return id
    },
    async prepared(id: string) {
      harness().resume()
      const live = await harness().commit(
        async (tx) =>
          (await tx.scanTasks({ kind: 'video.prepare', status: 'pending' }, 10)).items.concat(
            (await tx.scanTasks({ kind: 'video.prepare', status: 'running' }, 10)).items,
          ),
        context,
      )
      for (const task of live) await harness().waitForTask(task.id, context)
      return (await state())?.videos[id]
    },
  }
}
