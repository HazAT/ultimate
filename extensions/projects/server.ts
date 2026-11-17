import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineExtension } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { rebuiltOnOpen, meansNone } from '../../lib/errors.ts'
import { readJson, updateJson } from '../../lib/json-file.ts'
import { githubRepo, readGithubRepo } from '../../lib/project-identity.ts'
import type { GithubRepo } from '../../lib/project-identity.ts'
import { postAction } from '../../lib/remote.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { MessagesApi } from '../messages/api.ts'
import { ListAction, PinAction } from './refs.ts'
import type { RunningProject } from './refs.ts'

const REMOTE_COUNTS_TIMEOUT_MS = 1_500

type Counts = { busy: number; questions: number }

async function localCounts(host: ExtensionHost): Promise<Counts> {
  return {
    busy: host.conversations().filter((conversation) => conversation.busy).length,
    questions: (await host.need(MessagesApi).openQuestions(context)).length,
  }
}

async function timedRemoteCounts(name: string, url: string, signal: AbortSignal) {
  const status = (await postAction(
    { url, label: name },
    'status',
    'status',
    {},
    AbortSignal.any([signal, AbortSignal.timeout(REMOTE_COUNTS_TIMEOUT_MS)]),
  ).catch(meansNone)) as { busy?: unknown; questions?: { count?: unknown } } | undefined
  const busy = status?.busy
  const questions = status?.questions?.count
  return typeof busy === 'number' && typeof questions === 'number' ? { busy, questions } : {}
}

const repoCache = new Map<string, GithubRepo | null>()
const pendingRepoReads = new Set<string>()
function cachedRepo(root: string | undefined) {
  if (!root) return undefined
  if (!repoCache.has(root) && !pendingRepoReads.has(root)) {
    pendingRepoReads.add(root)
    rebuiltOnOpen(
      'a later project list reads the repository cache again',
      (async () => {
        const key = await githubRepo(root)
        repoCache.set(root, key ? await readGithubRepo(key) : null)
        pendingRepoReads.delete(root)
      })(),
    )
  }
  return repoCache.get(root) ?? undefined
}

function checkoutName(name: string, root: string | undefined) {
  const worktree = /\/\.ultimate\/projects\/(.+)-[\da-f]{8}\/worktrees\/(\d+)$/.exec(root ?? '')
  return worktree ? `${worktree[1]} #${worktree[2]}` : name
}

async function tailnetPorts(host: ExtensionHost) {
  type Registry = { ports?: Record<string, { port?: unknown }> }
  const registryOrNoPorts = await readJson<Registry>(
    join(host.userHome, '.ultimate', 'tailscale.json'),
    {},
  ).catch((): Registry => ({}))
  const ports: Record<string, number> = {}
  for (const [root, entry] of Object.entries(registryOrNoPorts.ports ?? {}))
    if (typeof entry?.port === 'number') ports[root] = entry.port
  return ports
}

export async function list(host: ExtensionHost, signal: AbortSignal): Promise<RunningProject[]> {
  const tailnet = await tailnetPorts(host)
  return Promise.all(
    (await host.projects()).flatMap(({ name, root, running, current }) => {
      const processOrLockUrl = current ? host.system().process.url : running?.url
      if (!processOrLockUrl) return []
      return [
        (async () => {
          const repo = cachedRepo(root)
          return {
            name: checkoutName(name, root),
            url: processOrLockUrl,
            current,
            ...(repo && { repo: { name: repo.name, url: repo.url, visibility: repo.visibility } }),
            ...(root && tailnet[root] ? { tailnetPort: tailnet[root] } : {}),
            ...(current
              ? await localCounts(host)
              : await timedRemoteCounts(name, processOrLockUrl, signal)),
          }
        })(),
      ]
    }),
  )
}

const sharedRailPinPath = (host: ExtensionHost) =>
  join(host.userHome, '.ultimate', 'projects-rail.json')
const readPin = async (path: string) => {
  const value = await readJson<{ pinned?: unknown }>(path, {})
  return { pinned: value.pinned === true }
}

export default function projects(host: ExtensionHost) {
  host.need(MessagesApi)
  return defineExtension({ name: 'projects' })
}

export const pollActions = ['list', 'pin']

export const actions = {
  list: implementAction(ListAction, (_args, { host, signal }) => list(host, signal)),
  pin: implementAction(PinAction, async (args, { host }) => {
    const pinned =
      args && typeof args === 'object' && !Array.isArray(args) ? args.pinned : undefined
    if (pinned !== undefined && typeof pinned !== 'boolean')
      throw new Error('pinned must be a boolean')
    const path = sharedRailPinPath(host)
    if (pinned !== undefined)
      await updateJson(path, readPin, (value) => {
        value.pinned = pinned
      })
    return readPin(path)
  }),
}
