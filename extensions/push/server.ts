import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { onCommit } from '../../lib/commits.ts'
import { readSecret } from '../../lib/secrets.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { OverviewState } from '../conversations/types.ts'
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
const OVERVIEW = 'ultimate.conversation-overview'

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
export const docs = [Closed]

const markTagClosed = (host: ExtensionHost, tag: string, closed: boolean) =>
  host.harness().commit(async (tx) => {
    const doc = await tx.doc(Closed, ROOT_CONVERSATION_ID)
    if (doc.tags.includes(tag) === closed) return
    const rest = doc.tags.filter((each) => each !== tag)
    doc.tags = closed ? [...rest, tag].slice(-CLOSED_TAG_HISTORY_LIMIT) : rest
  }, context)

const state = (host: ExtensionHost) =>
  host.resource('push.state', () => ({
    shown: new Map<string, number>(),
    sending: new Set<Promise<unknown>>(),
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

async function send(host: ExtensionHost, subscription: Subscription, push: Push) {
  const privateKey = await readSecret(host.userHome, KEY)
  if (!privateKey) throw new Error(`${KEY} is missing: turn notifications off and on again`)
  const { urgency, ...payload } = push
  const result = await sendPush(subscription, privateKey, payload, urgency)
  if (result.gone) await remove(host, subscription.endpoint)
  else if (result.error !== undefined)
    host.notice(`Push: the push service answered ${result.status} ${result.error}`)
  return result.status
}

function trackPushUntilClosed(host: ExtensionHost, work: Promise<unknown>) {
  const shared = state(host)
  const sending = work
    .catch((error: unknown) => host.notice(`Push: ${String(error)}`))
    .finally(() => shared.sending.delete(sending))
  shared.sending.add(sending)
}

const closed = async (host: ExtensionHost, tag: string) =>
  (await host.harness().snapshot(Closed, ROOT_CONVERSATION_ID, context))?.tags.includes(tag) ??
  false

function pushToHiddenBrowsers(host: ExtensionHost, push: Push) {
  const { shown: visibleEndpointsAt } = state(host)
  trackPushUntilClosed(
    host,
    subscriptions(host).then(async (all) =>
      (await closed(host, push.tag))
        ? []
        : Promise.all(
            all
              .filter(
                (each) =>
                  Date.now() - (visibleEndpointsAt.get(each.endpoint) ?? 0) >=
                  VISIBLE_BROWSER_GRACE_MS,
              )
              .map((each) => send(host, each, push)),
          ),
    ),
  )
}

export default function pushExtension(host: ExtensionHost) {
  host.need(SecretsApi)
  host.implement(PushApi, {
    notify: (push) => {
      trackPushUntilClosed(
        host,
        markTagClosed(host, push.tag, false).then(() => pushToHiddenBrowsers(host, push)),
      )
    },
    close: (tag) => trackPushUntilClosed(host, markTagClosed(host, tag, true)),
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
      if (push) pushToHiddenBrowsers(host, push)
    },
    { from: 'now' },
  )
  host.react(
    'landings',
    [SubmissionLanded],
    (_tx, { data }) => pushToHiddenBrowsers(host, landingPush(data)),
    {
      from: 'now',
    },
  )

  let stop: (() => void) | undefined
  let lastFailureTag: string | undefined
  const failed = async () => {
    const token = host.doc(OVERVIEW)
    if (!token) return undefined
    const [standing, overview] = await Promise.all([
      host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, context),
      host.harness().snapshot(token, ROOT_CONVERSATION_ID, context),
    ])
    const ultimate = standing?.ultimate
    if (ultimate === undefined) return undefined
    return failedPush((overview as OverviewState | undefined)?.conversations[ultimate], ultimate)
  }
  host.onOpen(async () => {
    lastFailureTag = (await failed())?.tag
    stop = onCommit(host.harness(), (publication) => {
      if (
        !publication.changes.some(
          (change) =>
            change.type === 'document' &&
            change.conversationId === ROOT_CONVERSATION_ID &&
            change.record.kind === OVERVIEW,
        )
      )
        return
      failed()
        .then((push) => {
          if (!push || push.tag === lastFailureTag) return
          lastFailureTag = push.tag
          pushToHiddenBrowsers(host, push)
        })
        .catch((error: unknown) => host.notice(`Push: ${String(error)}`))
    })
  })
  const close = async () => {
    stop?.()
    stop = undefined
    const { sending } = state(host)
    while (sending.size) await Promise.all(sending)
  }
  host.onRelease(close)
  host.onClose(close)
  return defineExtension({ name: 'push' })
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
