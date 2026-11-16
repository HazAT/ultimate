import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineExtension } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { meansNone } from '../../lib/errors.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { HealthApi } from '../health/api.ts'
import { MessagesApi } from '../messages/api.ts'
import { UpdateApi } from '../update/api.ts'
import { WatchdogApi } from '../watchdog/api.ts'
import { StatusAction } from './refs.ts'
import type { Status } from './refs.ts'

const DAY = 24 * 60 * 60_000

async function projectProgress(host: ExtensionHost, signal: AbortSignal) {
  for (const extension of host.extensions()) {
    if (
      extension.name === 'status' ||
      !extension.enabled ||
      !extension.actions.includes('projectProgress')
    )
      continue
    const value = await host.invoke(extension.name, 'projectProgress', {}, signal).catch(meansNone)
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const { label, index, total } = value as Record<string, unknown>
    if (
      typeof label === 'string' &&
      label.trim() &&
      typeof index === 'number' &&
      Number.isSafeInteger(index) &&
      index >= 0 &&
      typeof total === 'number' &&
      Number.isSafeInteger(total) &&
      total > 0 &&
      index <= total
    )
      return { label, index, total }
  }
  return undefined
}

export async function status(
  host: ExtensionHost,
  since: number,
  now: number,
  signal: AbortSignal,
): Promise<Status> {
  const update = host.want(UpdateApi)
  const watchdog = host.want(WatchdogApi)
  const health = host.want(HealthApi)
  const updateState = update?.state().catch(meansNone)
  const [clone, failures, providers, open, progress] = await Promise.all([
    updateState,
    watchdog?.failures(since),
    health?.providers(),
    host.need(MessagesApi).openQuestions(context),
    projectProgress(host, signal),
  ])
  const first = open[0]
  return {
    at: now,
    ...(progress ? { progress } : {}),
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
  host.need(MessagesApi)
  host.want(UpdateApi)
  host.want(WatchdogApi)
  host.want(HealthApi)
  return defineExtension({ name: 'status' })
}

export const pollActions = ['status']

export const actions = {
  status: implementAction(StatusAction, (args, { host, signal }) => {
    const since = args && typeof args === 'object' && !Array.isArray(args) ? args.since : undefined
    if (since !== undefined && (typeof since !== 'number' || !Number.isFinite(since)))
      throw new Error('since must be epoch milliseconds')
    const now = Date.now()
    return status(host, since ?? now - DAY, now, signal)
  }),
}
