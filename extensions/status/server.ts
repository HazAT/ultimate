/** Status: one compact read-only summary of this Ultimate, each field from the extension that owns it. */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineExtension } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { HealthApi } from '../health/api.ts'
import { MessagesApi } from '../messages/api.ts'
import { UpdateApi } from '../update/api.ts'
import { WatchdogApi } from '../watchdog/api.ts'
import { StatusAction } from './refs.ts'
import type { Status } from './refs.ts'

const DAY = 24 * 60 * 60_000

export async function status(host: ExtensionHost, since: number, now: number): Promise<Status> {
  const update = host.want(UpdateApi)
  const watchdog = host.want(WatchdogApi)
  const health = host.want(HealthApi)
  // Update throws while origin has no default branch (lib/fast-forward.ts `standing`), which failed every dashboard poll
  // until `git remote set-head origin --auto`. The clone is then unknown, so `head` stays out, as with Update off.
  const updateState = update?.state().catch(() => undefined)
  const [clone, failures, providers, open] = await Promise.all([
    updateState,
    watchdog?.failures(since),
    health?.providers(),
    host.need(MessagesApi).openQuestions(context),
  ])
  const first = open[0]
  return {
    at: now,
    ...(clone?.head
      ? {
          head: {
            sha: clone.head,
            ...(clone.branch ? { branch: clone.branch } : {}),
            behind: clone.behind,
            ahead: clone.ahead ?? 0,
            ...(clone.fetchedAt ? { fetchedAt: clone.fetchedAt } : {}),
            ...(clone.error ? { error: clone.error } : {}),
          },
        }
      : {}),
    ...(failures
      ? {
          failures: failures.map(({ conversation, title, at, error, retried }) => ({
            conversation,
            title,
            at,
            error,
            retried,
          })),
        }
      : {}),
    ...(providers
      ? {
          providers: providers.map(({ provider, state, error }) => ({
            provider,
            state,
            ...(state === 'failing' && error ? { error } : {}),
          })),
        }
      : {}),
    questions: {
      count: open.length,
      ...(first
        ? {
            first: { text: first.text, conversation: first.conversation, message: first.message },
          }
        : {}),
    },
    busy: host.conversations().filter((conversation) => conversation.busy).length,
    extensions: host.extensions().map(({ name, source, enabled, server }) => ({
      name,
      source,
      enabled,
      ...(server?.error ? { error: server.error } : {}),
    })),
  }
}

export default function statusExtension(host: ExtensionHost) {
  // Resolved where they are called; declared here so the catalogue lists them.
  host.need(MessagesApi)
  host.want(UpdateApi)
  host.want(WatchdogApi)
  host.want(HealthApi)
  return defineExtension({ name: 'status' })
}

/** Dashboards poll it: the trace counts its repeats instead of writing each. */
export const pollActions = ['status']

export const actions = {
  status: implementAction(StatusAction, (args, { host }) => {
    const since = args && typeof args === 'object' && !Array.isArray(args) ? args.since : undefined
    if (since !== undefined && (typeof since !== 'number' || !Number.isFinite(since)))
      throw new Error('since must be epoch milliseconds')
    const now = Date.now()
    return status(host, since ?? now - DAY, now)
  }),
}
