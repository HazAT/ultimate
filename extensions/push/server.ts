/**
 * Push: Web Push notifications for questions to the user (with Approve and Reply), landings and @ultimate's failed
 * runs. Adapted from mjaverto/ultimate's notifications extension (MIT, https://github.com/mjaverto/ultimate).
 */
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
import { KeyAction, PresentAction, SubscribeAction, TestAction, UnsubscribeAction } from './refs.ts'
import type { Subscription } from './refs.ts'
import { failedPush, landingPush, questionPush } from './rules.ts'
import type { Push } from './rules.ts'

const KEY = 'WEB_PUSH_VAPID_KEY'
const OVERVIEW = 'ultimate.conversation-overview'

/** The subscribed browsers, with their encryption keys: on the root, never exported to the page. */
const Subscriptions = defineDoc<{ subscriptions: Subscription[] }>({
  kind: 'push.subscriptions',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ subscriptions: [] }),
})

const state = (host: ExtensionHost) =>
  host.resource('push.state', () => ({
    /** When each endpoint last reported the app on screen. */
    shown: new Map<string, number>(),
    sending: new Set<Promise<unknown>>(),
    keying: undefined as Promise<string> | undefined,
  }))

/** The VAPID public key, made and stored in Secrets on first use. */
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
  (await host.harness().snapshot(Subscriptions, ROOT_CONVERSATION_ID, context))?.subscriptions ?? []

const remove = (host: ExtensionHost, endpoint: string) =>
  host.harness().commit(async (tx) => {
    const doc = await tx.doc(Subscriptions, ROOT_CONVERSATION_ID)
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

/** Pushes to every subscribed browser not showing the app. Never awaited in a reactor's transaction. */
function deliver(host: ExtensionHost, push: Push) {
  const shared = state(host)
  const sending = subscriptions(host)
    .then((all) =>
      Promise.all(
        all
          .filter((each) => Date.now() - (shared.shown.get(each.endpoint) ?? 0) >= 15_000)
          .map((each) => send(host, each, push)),
      ),
    )
    .catch((error: unknown) => host.notice(`Push: ${String(error)}`))
    .finally(() => shared.sending.delete(sending))
  shared.sending.add(sending)
}

export default function pushExtension(host: ExtensionHost) {
  host.need(SecretsApi)
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
      if (push) deliver(host, push)
    },
    { from: 'now' },
  )
  host.react('landings', [SubmissionLanded], (_tx, { data }) => deliver(host, landingPush(data)), {
    from: 'now',
  })

  // @ultimate's failed run is no domain event but a change of Pi's overview document, as the sounds read it.
  let stop: (() => void) | undefined
  let seen: string | undefined
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
    // What has failed already when the server opens is old news.
    seen = (await failed())?.tag
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
          if (!push || push.tag === seen) return
          seen = push.tag
          deliver(host, push)
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
      const doc = await tx.doc(Subscriptions, ROOT_CONVERSATION_ID)
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

/** Subscribing is the user's choice, never an agent's. */
export const userActions = ['key', 'subscribe', 'unsubscribe', 'test', 'present']
