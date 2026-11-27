import { afterEach, expect, it, vi } from 'vitest'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import pushExtension, { actions, docs } from '../server.ts'
import { context, prepareHarness } from '../../../server/harness.ts'
import type { OpenHost } from '../../../server/harness.ts'
import type { PushService } from '../api.ts'
import type { Push } from '../rules.ts'
import { openers, temp, until, createTestExtensionHost } from '../../../test/helpers.ts'

const sending = vi.hoisted(() => ({
  sent: [] as { endpoint: string; payload: object }[],
  hang: false,
}))
vi.mock('../push.ts', () => ({
  sendPush: async (
    subscription: { endpoint: string },
    _key: string,
    payload: object,
    _urgency: string,
    signal?: AbortSignal,
  ) => {
    sending.sent.push({ endpoint: subscription.endpoint, payload })
    if (sending.hang)
      await new Promise((_done, fail) =>
        signal?.addEventListener('abort', () => fail(signal.reason), { once: true }),
      )
    return { status: 201, gone: false }
  },
}))
vi.mock('../../../lib/secrets.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/secrets.ts')>()),
  readSecret: () => Promise.resolve('private-key'),
}))

const opened: OpenHost[] = []
afterEach(async () => {
  for (const host of opened.splice(0)) await host.close()
  sending.sent.length = 0
  sending.hang = false
})

const subscription = (endpoint: string) => ({
  endpoint,
  keys: { p256dh: 'p', auth: 'a' },
  origin: 'https://app.example.com',
})

async function fixture() {
  const home = await temp('ultimate-push-')
  const prepared = await prepareHarness({ home, ultimateRoot: home, userHome: home })
  let service: PushService | undefined
  let current: OpenHost
  const resources = new Map<string, unknown>()
  const lifecycle = openers()
  const host = createTestExtensionHost({
    ...prepared,
    harness: () => current.harness,
    need: () => ({}),
    implement: (_api: unknown, value: PushService) => (service = value),
    react: () => {},
    onOpen: lifecycle.onOpen,
    notice: (message: string) => {
      throw new Error(message)
    },
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key)
    },
  })
  prepared.registry.install(pushExtension(host))
  const open = async () => {
    await lifecycle.close()
    current = await prepared.open()
    opened.push(current)
    await lifecycle.open()
  }
  await open()
  return {
    host,
    service: () => service!,
    open,
    close: async () => {
      opened.splice(opened.indexOf(current), 1)
      await current.close()
    },
    delivered: async () => {
      current.harness.resume()
      const live = await current.harness.commit(
        async (tx) =>
          (await tx.scanTasks({ kind: 'push.deliver', status: 'pending' }, 10)).items.concat(
            (await tx.scanTasks({ kind: 'push.deliver', status: 'running' }, 10)).items,
          ),
        context,
      )
      for (const task of live) await current.harness.waitForTask(task.id, context)
      return live.length
    },
    closedTags: async () =>
      (await current.harness.snapshot(docs[0], ROOT_CONVERSATION_ID, context))?.tags,
  }
}

const push: Push = {
  title: 'Ultimate',
  body: 'sudo pacman -Syu waits for you',
  tag: 'shell:3',
  path: '/?inbox=shell:3',
  urgency: 'high',
}

it('notifies every subscribed browser but the one on screen, and closes by tag', async () => {
  const f = await fixture()
  const ctx = { host: f.host } as Parameters<typeof actions.subscribe>[1]
  for (const endpoint of ['https://push.example.com/away', 'https://push.example.com/here'])
    await actions.subscribe({ subscription: subscription(endpoint) }, ctx)
  actions.present({ endpoint: 'https://push.example.com/here', visible: true }, ctx)

  await f.service().close('shell:3')
  expect(await f.closedTags()).toEqual(['shell:3'])
  // A new push under a closed tag opens it again.
  await f.service().notify(push)
  await until(() => sending.sent.length === 1)
  expect(sending.sent).toEqual([
    {
      endpoint: 'https://push.example.com/away',
      payload: { title: 'Ultimate', body: push.body, tag: 'shell:3', path: push.path },
    },
  ])
  expect(await f.closedTags()).toEqual([])
})

it('delivers a push a crash cut off once the host opens again', async () => {
  // Pushes were promises in memory: a crash before the send finished lost them for good.
  const f = await fixture()
  const ctx = { host: f.host } as Parameters<typeof actions.subscribe>[1]
  await actions.subscribe({ subscription: subscription('https://push.example.com/away') }, ctx)
  sending.hang = true
  await f.service().notify(push)
  await until(() => sending.sent.length === 1)
  await f.close()
  sending.hang = false
  await f.open()
  expect(await f.delivered()).toBe(1)
  expect(sending.sent).toHaveLength(2)
  expect(sending.sent[1].payload).toMatchObject({ tag: 'shell:3' })
})
