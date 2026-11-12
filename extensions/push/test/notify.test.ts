import { expect, it, vi } from 'vitest'
import type { Tx } from '@earendil-works/pi-durable'
import pushExtension, { actions } from '../server.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import type { PushService } from '../api.ts'
import type { Push } from '../rules.ts'

const sent = vi.hoisted(() => [] as { endpoint: string; payload: object }[])
vi.mock('../push.ts', () => ({
  sendPush: (subscription: { endpoint: string }, _key: string, payload: object) => {
    sent.push({ endpoint: subscription.endpoint, payload })
    return Promise.resolve({ status: 201, gone: false })
  },
}))
vi.mock('../../../lib/secrets.ts', () => ({ readSecret: () => Promise.resolve('private-key') }))

const subscription = (endpoint: string) => ({
  endpoint,
  keys: { p256dh: 'p', auth: 'a' },
  origin: 'https://app.example.com',
})

/** A host over plain documents keyed by kind, with the extension's resources and close hooks. */
function fakeHost() {
  const docs = new Map<string, object>()
  const doc = (def: { kind: string; initial: () => object }) => {
    if (!docs.has(def.kind)) docs.set(def.kind, def.initial())
    return docs.get(def.kind)!
  }
  const tx = {
    doc: async ({ definition }: { definition: { kind: string; initial: () => object } }) =>
      doc(definition),
  } as unknown as Tx
  const resources = new Map<string, unknown>()
  const closers: (() => Promise<void>)[] = []
  let service: PushService | undefined
  const host = {
    need: () => ({}),
    implement: (_api: unknown, value: PushService) => (service = value),
    react: () => {},
    onOpen: () => {},
    onRelease: () => {},
    onClose: (callback: () => Promise<void>) => closers.push(callback),
    notice: (message: string) => {
      throw new Error(message)
    },
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key)
    },
    harness: () => ({
      commit: (fn: (tx: Tx) => unknown) => fn(tx),
      snapshot: async ({ definition }: { definition: { kind: string; initial: () => object } }) =>
        doc(definition),
    }),
  } as unknown as ExtensionHost
  pushExtension(host)
  return {
    host,
    service: service!,
    docs,
    settle: () => Promise.all(closers.map((close) => close())),
  }
}

it('notifies every subscribed browser but the one on screen, and closes by tag', async () => {
  const { host, service, docs, settle } = fakeHost()
  const context = { host } as Parameters<typeof actions.subscribe>[1]
  for (const endpoint of ['https://push.example.com/away', 'https://push.example.com/here'])
    await actions.subscribe({ subscription: subscription(endpoint) }, context)
  actions.present({ endpoint: 'https://push.example.com/here', visible: true }, context)

  const push: Push = {
    title: 'Ultimate',
    body: 'sudo pacman -Syu waits for you',
    tag: 'shell:3',
    path: '/?inbox=shell:3',
    urgency: 'high',
  }
  service.close('shell:3')
  await settle()
  expect(docs.get('push.closed')).toEqual({ tags: ['shell:3'] })
  // A new push under a closed tag opens it again.
  service.notify(push)
  await settle()
  expect(sent).toEqual([
    {
      endpoint: 'https://push.example.com/away',
      payload: { title: 'Ultimate', body: push.body, tag: 'shell:3', path: push.path },
    },
  ])
  expect(docs.get('push.closed')).toEqual({ tags: [] })
})
