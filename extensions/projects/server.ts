/**
 * Projects: the Ultimate instances running on this machine, from the host's project list (`host.projects()`), each
 * with its live counts from its own `status` action, for the rail's project switcher.
 */
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineExtension } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { readJson, updateJson } from '../../lib/json-file.ts'
import { postAction } from '../../lib/remote.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { MessagesApi } from '../messages/api.ts'
import { ListAction, PinAction } from './refs.ts'
import type { RunningProject } from './refs.ts'

/** How long the list waits for another instance's counts; a slower one shows without them until the next poll. */
const STATUS_WAIT = 1_500

type Counts = { busy: number; questions: number }

/** This instance's counts, as its own `status` action reports them. */
async function own(host: ExtensionHost): Promise<Counts> {
  return {
    busy: host.conversations().filter((conversation) => conversation.busy).length,
    questions: (await host.need(MessagesApi).openQuestions(context)).length,
  }
}

/** Another instance's counts from its `status` action, or nothing when it does not answer in time. */
async function counts(name: string, url: string, signal: AbortSignal) {
  const status = (await postAction(
    { url, label: name },
    'status',
    'status',
    {},
    AbortSignal.any([signal, AbortSignal.timeout(STATUS_WAIT)]),
  ).catch(() => {
    // Down, slow or without the status extension: the rail lists it without live state.
    return undefined
  })) as { busy?: unknown; questions?: { count?: unknown } } | undefined
  const busy = status?.busy
  const questions = status?.questions?.count
  return typeof busy === 'number' && typeof questions === 'number' ? { busy, questions } : {}
}

export async function list(host: ExtensionHost, signal: AbortSignal): Promise<RunningProject[]> {
  return Promise.all(
    (await host.projects()).flatMap(({ name, running, current }) => {
      // This server answers whether or not a supervisor wrote its port into the lock (a preview's has none).
      const url = current ? host.system().process.url : running?.url
      if (!url) return []
      return [
        (async () => ({
          name,
          url,
          current,
          ...(current ? await own(host) : await counts(name, url, signal)),
        }))(),
      ]
    }),
  )
}

/** The rail's pin, one file for every instance on this machine, so jumping keeps the rail as it was. */
const pinPath = (host: ExtensionHost) => join(host.userHome, '.ultimate', 'projects-rail.json')
const readPin = async (path: string) => {
  const value = await readJson<{ pinned?: unknown }>(path, {})
  return { pinned: value.pinned === true }
}

export default function projects(host: ExtensionHost) {
  // Resolved where it is called; declared here so the catalogue lists it.
  host.need(MessagesApi)
  return defineExtension({ name: 'projects' })
}

/** The rail polls both: the trace counts their repeats instead of writing each. */
export const pollActions = ['list', 'pin']

export const actions = {
  list: implementAction(ListAction, (_args, { host, signal }) => list(host, signal)),
  pin: implementAction(PinAction, async (args, { host }) => {
    const pinned =
      args && typeof args === 'object' && !Array.isArray(args) ? args.pinned : undefined
    if (pinned !== undefined && typeof pinned !== 'boolean')
      throw new Error('pinned must be a boolean')
    const path = pinPath(host)
    if (pinned !== undefined)
      await updateJson(path, readPin, (value) => {
        value.pinned = pinned
      })
    return readPin(path)
  }),
}
