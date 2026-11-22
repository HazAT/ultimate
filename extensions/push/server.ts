import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { Tx } from '@earendil-works/pi-durable'
import { defineEffect } from '../../lib/effect.ts'
import { rebuiltOnOpen } from '../../lib/errors.ts'
import { implementAction } from '../../lib/actions.ts'
import { onCommit } from '../../lib/commits.ts'
import { readSecret } from '../../lib/secrets.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Overview } from '../conversations/api.ts'
import { Messages, MessageSent } from '../messages/api.ts'
import { SecretsApi } from '../secrets/api.ts'
import { Standing } from '../subagents/api.ts'
import { SubmissionLanded } from '../workspaces/api.ts'
import { newKey, publicKey, sendPush } from './push.ts'
import { PushApi } from './api.ts'
import {
  ClosedDoc,
  KeyAction,
  PresentAction,
  SubscribeAction,
  TestAction,
  UnsubscribeAction,
} from './refs.ts'
import type { Subscription } from './refs.ts'
import { failedPush, landingPush, questionPush } from './rules.ts'
import type { Push } from './rules.ts'

const KEY = 'WEB_PUSH_VAPID_KEY'

const ServerOnlySubscriptions = defineDoc<{ subscriptions: Subscription[] }>({
  kind: 'push.subscriptions',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ subscriptions: [] }),
})

const CLOSED_TAG_HISTORY_LIMIT = 50
const VISIBLE_BROWSER_GRACE_MS = 15_000
const Closed = defineDoc<{ tags: string[] }>({
  kind: ClosedDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ tags: [] }),
})
const LastFailureTag = defineDoc<{ tag?: string }>({
  kind: 'push.last-failure',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
export const docs = [Closed]

async function markTagClosed(tx: Tx, tag: string, closed: boolean) {
  const doc = await tx.doc(Closed, ROOT_CONVERSATION_ID)
  if (doc.tags.includes(tag) === closed) return
  const rest = doc.tags.filter((each) => each !== tag)
  doc.tags = closed ? [...rest, tag].slice(-CLOSED_TAG_HISTORY_LIMIT) : rest
}

const state = (host: ExtensionHost) =>
  host.resource('push.state', () => ({
    shown: new Map<string, number>(),
    keying: undefined as Promise<string> | undefined,
  }))

function key(host: ExtensionHost) {
  const shared = state(host)
  shared.keying ??= (async () => {
    let scalar = await readSecret(host.userHome, KEY)
    if (!scalar) {
      scalar = newKey()
      await host.need(SecretsApi).set(KEY, scalar)
    }
    return publicKey(scalar).toString('base64url')
  })().finally(() => {
    shared.keying = undefined
  })
  return shared.keying
}

const subscriptions = async (host: ExtensionHost) =>
  (await host.harness().snapshot(ServerOnlySubscriptions, ROOT_CONVERSATION_ID, context))
    ?.subscriptions ?? []

const remove = (host: ExtensionHost, endpoint: string) =>
  host.harness().commit(async (tx) => {
    const doc = await tx.doc(ServerOnlySubscriptions, ROOT_CONVERSATION_ID)
    doc.subscriptions = doc.subscriptions.filter((each) => each.endpoint !== endpoint)
  }, context)

async function send(
  host: ExtensionHost,
  subscription: Subscription,
  push: Push,
  signal?: AbortSignal,
) {
  const privateKey = await readSecret(host.userHome, KEY)
  if (!privateKey) throw new Error(`${KEY} is missing: turn notifications off and on again`)
  const { urgency, ...payload } = push
  const result = await sendPush(subscription, privateKey, payload, urgency, signal)
  if (result.gone) await remove(host, subscription.endpoint)
  else if (result.error !== undefined)
    host.notice(`Push: the push service answered ${result.status} ${result.error}`)
  return result.status
}

const closed = async (host: ExtensionHost, tag: string) =>
  (await host.harness().snapshot(Closed, ROOT_CONVERSATION_ID, context))?.tags.includes(tag) ??
  false

const deliver = (host: ExtensionHost) =>
  defineEffect<Push, number>('push.deliver', async (push, { signal }) => {
    if (await closed(host, push.tag)) return 0
    const { shown: visibleEndpointsAt } = state(host)
    const hidden = (await subscriptions(host)).filter(
      (each) =>
        Date.now() - (visibleEndpointsAt.get(each.endpoint) ?? 0) >= VISIBLE_BROWSER_GRACE_MS,
    )
    await Promise.all(hidden.map((each) => send(host, each, push, signal))).catch(
      (error: unknown) => {
        if (!signal.aborted) host.notice(`Push: ${String(error)}`)
        throw error
      },
    )
    return hidden.length
  })

export default function pushExtension(host: ExtensionHost) {
  host.need(SecretsApi)
  const Deliver = deliver(host)
  const pushToHiddenBrowsers = async (tx: Tx, push: Push) => {
    await tx.createTask(Deliver, push, {
      conversationId: ROOT_CONVERSATION_ID,
      ownership: { kind: 'conversation' },
      background: true,
    })
  }
  const committed = (change: (tx: Tx) => Promise<void>) =>
    host
      .harness()
      .commit(change, context)
      .then(() => host.harness().resume())
      .catch((error: unknown) => host.notice(`Push: ${String(error)}`))
  host.implement(PushApi, {
    notify: (push) =>
      committed(async (tx) => {
        await markTagClosed(tx, push.tag, false)
        await pushToHiddenBrowsers(tx, push)
      }),
    close: (tag) => committed((tx) => markTagClosed(tx, tag, true)),
  })
  host.react(
    'questions',
    [MessageSent],
    async (tx, { data }) => {
      if (data.to !== 'user' || !data.reply) return
      const message = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
        (each) => each.id === data.message,
      )
      if (!message) return
      const ultimate = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
      const title = host.conversations().find((each) => each.id === data.from)?.title
      const push = questionPush(message, ultimate, title)
      if (push) await pushToHiddenBrowsers(tx, push)
    },
    { from: 'now' },
  )
  host.react(
    'landings',
    [SubmissionLanded],
    (tx, { data }) => pushToHiddenBrowsers(tx, landingPush(data)),
    {
      from: 'now',
    },
  )

  const pushNewFailure = async (tx: Tx) => {
    const ultimate = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
    if (ultimate === undefined) return
    const overview = await tx.doc(Overview, ROOT_CONVERSATION_ID)
    const push = failedPush(overview.conversations[ultimate], ultimate)
    const last = await tx.doc(LastFailureTag, ROOT_CONVERSATION_ID)
    if (last.tag === undefined) {
      last.tag = push?.tag ?? ''
      return
    }
    if (!push || push.tag === last.tag) return
    last.tag = push.tag
    await pushToHiddenBrowsers(tx, push)
  }
  host.onOpen(async (opened) => {
    await committed(pushNewFailure)
    const stop = onCommit(host.harness(), (publication) => {
      if (
        !publication.changes.some(
          (change) =>
            change.type === 'document' &&
            change.conversationId === ROOT_CONVERSATION_ID &&
            change.record.kind === Overview.definition.kind,
        )
      )
        return
      rebuiltOnOpen(
        'push.last-failure claims the tag in the commit; open and overview changes recheck it',
        committed(pushNewFailure),
      )
    })
    opened.defer(stop)
  })
  return defineExtension({ name: 'push', tasks: [Deliver] })
}

function endpointOf(args: unknown) {
  const endpoint = (args as { endpoint?: unknown } | null)?.endpoint
  if (typeof endpoint !== 'string' || new URL(endpoint).protocol !== 'https:')
    throw new Error('Expected an HTTPS push endpoint')
  return endpoint
}

export const actions = {
  key: implementAction(KeyAction, async (_args, { host }) => ({ key: await key(host) })),
  subscribe: implementAction(SubscribeAction, async (args, { host }) => {
    const given = (args as { subscription?: Partial<Subscription> } | null)?.subscription
    const endpoint = endpointOf(given)
    const keys = given?.keys
    const origin = given?.origin
    if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string')
      throw new Error('Expected subscription keys p256dh and auth')
    if (typeof origin !== 'string' || new URL(origin).origin !== origin)
      throw new Error('Expected the page origin')
    await host.harness().commit(async (tx) => {
      const doc = await tx.doc(ServerOnlySubscriptions, ROOT_CONVERSATION_ID)
      doc.subscriptions = [
        ...doc.subscriptions.filter((each) => each.endpoint !== endpoint),
        { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, origin },
      ]
    }, context)
    return null
  }),
  unsubscribe: implementAction(UnsubscribeAction, async (args, { host }) => {
    await remove(host, endpointOf(args))
    return null
  }),
  test: implementAction(TestAction, async (args, { host }) => {
    const endpoint = endpointOf(args)
    const subscription = (await subscriptions(host)).find((each) => each.endpoint === endpoint)
    if (!subscription) throw new Error('This browser is not subscribed')
    const status = await send(host, subscription, {
      title: 'Ultimate',
      body: 'Notifications are on for this device.',
      tag: 'test',
      path: '/',
      urgency: 'normal',
    })
    return { status }
  }),
  present: implementAction(PresentAction, (args, { host }) => {
    const endpoint = endpointOf(args)
    const { shown } = state(host)
    if ((args as { visible?: unknown }).visible === true) shown.set(endpoint, Date.now())
    else shown.delete(endpoint)
    return null
  }),
}

export const userActions = ['key', 'subscribe', 'unsubscribe', 'test', 'present']
