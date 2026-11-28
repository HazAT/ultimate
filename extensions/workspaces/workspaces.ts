import { parseConversationId } from '../../lib/ids.shared.ts'
import type { ConversationId, Cursor, Tx } from '@earendil-works/pi-durable'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import {
  configure,
  defineDoc,
  defineTask,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import { exec } from '../../lib/exec.ts'
import { git, isolatable } from '../../lib/git.ts'
import { meansNone, overshadowed, settled } from '../../lib/errors.shared.ts'
import { needsRestart as restartNeeded } from '../../lib/layers.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ConversationsApi, ExternalSessions } from '../conversations/api.ts'
import { Branches } from './api.ts'
import { StillOpenEntry, WorkspacesDoc } from './refs.ts'
import { setup } from './setup.ts'
import {
  addCheckout,
  clearCheckout,
  hasAddCommand,
  removeCheckout as removeCheckoutWithoutForce,
  treeName,
  treePath,
} from './tree.ts'
import {
  contains,
  createLander,
  activeLandingCards,
  hasPendingLanderReport,
  landerCheckout,
  landerPath,
  log,
} from './lander.ts'
import type {
  LandResult,
  SubmitResult,
  WorkspaceIndex,
  WorkspaceDisk,
  WorkspaceInfo,
  WorkspaceStats,
} from './types.ts'
import type { KeptWork } from '../conversations/types.ts'
import { checkpointEvery } from '../../shared/checkpoint.ts'

export const Workspaces = defineDoc<WorkspaceIndex>({
  kind: WorkspacesDoc.kind,
  checkpointWhen: checkpointEvery(100),
  version: 4,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ items: {}, queue: [], landers: {}, landerConversations: {}, results: {} }),
  migrate: (value, from) => {
    if (from < 3)
      return {
        ...(from < 2
          ? { items: (value as Pick<WorkspaceIndex, 'items'>).items, queue: [], landers: {} }
          : (value as Pick<WorkspaceIndex, 'items' | 'queue' | 'landers'>)),
        landerConversations: {},
        results: {},
      }
    const indexBeforeSubmissionSteps = value as WorkspaceIndex
    return {
      ...indexBeforeSubmissionSteps,
      queue: indexBeforeSubmissionSteps.queue.map((item) => ({ ...item, steps: [] })),
      results: Object.fromEntries(
        Object.entries(indexBeforeSubmissionSteps.results).map(([id, result]) => [
          id,
          { ...result, tip: id.split('-')[1], steps: [] },
        ]),
      ),
    }
  },
})
export async function landingPending(tx: Tx, id: ConversationId) {
  const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
  return (
    index.queue.some((item) => item.conversationId === id) ||
    (await hasPendingLanderReport(tx, index, id))
  )
}

export async function pendingLandingCards(tx: Tx) {
  return activeLandingCards(tx, await tx.doc(Workspaces, ROOT_CONVERSATION_ID))
}

const tasksStartedByThisModule = new Set<number>()
async function landerIdle(tx: Tx, index: WorkspaceIndex, source: string) {
  const running = index.landers[source]
  const live = running === undefined ? undefined : await tx.task(running)
  return !live || live.state.status === 'terminal' || live.state.status === 'completing'
}
type Host = Pick<
  ExtensionHost,
  | 'harness'
  | 'home'
  | 'ultimateRoot'
  | 'projectRoot'
  | 'projectSettings'
  | 'need'
  | 'want'
  | 'resource'
  | 'extensions'
  | 'metadata'
  | 'doc'
  | 'notice'
  | 'emit'
>
async function changes(
  id: ConversationId,
  workspace: WorkspaceIndex['items'][string],
): Promise<KeptWork> {
  return {
    id,
    uncommitted: (await git(workspace.path, 'status', '--porcelain')).split('\n').filter(Boolean)
      .length,
    unlanded: Number(
      await git(
        workspace.path,
        'rev-list',
        '--count',
        `${workspace.target}..${workspace.branch}`,
        `${workspace.target}..HEAD`,
      ),
    ),
  }
}
async function onDisk(path: string) {
  return lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return false
    },
  )
}
async function workLostWithCheckout(
  workspace: Pick<WorkspaceIndex['items'][string], 'path' | 'branch' | 'target'>,
): Promise<Omit<KeptWork, 'id'>> {
  const branch = (await git(workspace.path, 'branch', '--list', workspace.branch))
    ? [workspace.branch]
    : []
  return {
    uncommitted: (await git(workspace.path, 'status', '--porcelain')).split('\n').filter(Boolean)
      .length,
    unlanded: Number(
      await git(
        workspace.path,
        'rev-list',
        '--count',
        'HEAD',
        '--not',
        workspace.target,
        ...branch,
      ),
    ),
  }
}
const failure = (error: unknown) => (error instanceof Error ? error.message : String(error))
const workHeldByRegisteredCheckout = (
  id: ConversationId,
  workspace: WorkspaceIndex['items'][string],
  registered: boolean,
): Promise<KeptWork> =>
  registered
    ? workLostWithCheckout(workspace).then(
        (work) => ({ id, ...work }),
        (error: unknown) => ({ id, uncommitted: 0, unlanded: 0, reason: failure(error) }),
      )
    : Promise.resolve({ id, uncommitted: 0, unlanded: 0 })
async function listedBySource(workspace: WorkspaceIndex['items'][string]) {
  return (await git(workspace.source, 'worktree', 'list', '--porcelain'))
    .split('\n\n')
    .some((entry) => entry.split('\n').includes(`worktree ${workspace.path}`))
}
async function onlyIgnored(workspace: WorkspaceIndex['items'][string]) {
  const entries = await readdir(workspace.path, { withFileTypes: true })
  if (!entries.length) return true
  const paths = entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
  const ignored = await git(workspace.source, 'check-ignore', '--no-index', '--', ...paths).catch(
    () => '',
  )
  const matched = new Set(ignored.split('\n'))
  return paths.every((path) => matched.has(path))
}
async function registeredCheckout(workspace: WorkspaceIndex['items'][string]) {
  if (!(await onDisk(workspace.path))) return false
  const listed = await git(workspace.path, 'worktree', 'list', '--porcelain').catch(() => '')
  return listed
    .split('\n\n')
    .some((entry) => entry.split('\n').includes(`worktree ${workspace.path}`))
}
export function workspaces(host: Host) {
  const sourceWriteQueues = host.resource(
    'workspaces.land',
    () => new Map<string, Promise<unknown>>(),
  )
  async function serializeSourceWrites<T>(source: string, operation: () => Promise<T>): Promise<T> {
    const queued = settled(sourceWriteQueues.get(source) ?? Promise.resolve()).then(operation)
    sourceWriteQueues.set(source, queued)
    try {
      return await queued
    } finally {
      if (sourceWriteQueues.get(source) === queued) sourceWriteQueues.delete(source)
    }
  }
  const disk = host.resource(
    'workspaces.disk',
    (): { last?: WorkspaceDisk; running?: Promise<WorkspaceDisk> } => ({}),
  )
  const Lander = createLander(host, Workspaces, serializeSourceWrites, {
    starter: async (id, context) => host.want(Branches)?.starter(id, context),
    working: async (tx, id) => (await host.want(Branches)?.working(tx, id)) ?? false,
    conclude: async (tx, id) =>
      void (await host.need(ConversationsApi).concludeIn(tx, [id], 'landing')),
    reserveLanding: async (tx, id, result) => {
      await host.want(Branches)?.reserveLanding(tx, id, result)
    },
    retireLanding: async (tx, result) => {
      await host.want(Branches)?.retireLanding(tx, result)
    },
    submitLanding: async (tx, to, input, id, result) => {
      const messages = host.want(Branches)
      if (messages) await messages.submitLanding(tx, to, input, id, result)
      else await to.submit(tx, input)
    },
    release: (id, context) => release([id], context),
  })
  async function settleLanded(
    id: ConversationId,
    context: Context,
    current: (tx: Tx) => Promise<boolean>,
  ) {
    if (!(await get(id, context))?.landedOpen) return
    const starter = await host.want(Branches)?.starter(id, context)
    const to =
      starter === undefined || starter === id
        ? undefined
        : await host.harness().conversation(starter, context)
    const concluded = await host.harness().commit(async (tx) => {
      const open = (await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)]?.landedOpen
      if (!open) return false
      if ((await host.need(ConversationsApi).concludedIn(tx)).has(id)) {
        delete (await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)].landedOpen
        return true
      }
      if (!(await current(tx))) return false
      if ((await tx.doc(LiveDoc, id)).run || (await tx.doc(InboxDoc, id)).items.length) return false
      if (await host.want(Branches)?.working(tx, id)) {
        if (open.escalated || !to) return false
        await to.submit(tx, {
          type: 'input',
          requestId: `landed-open:${open.submission}`,
          whenBusy: 'followUp',
          entry: { kind: StillOpenEntry.kind, data: { id, submission: open.submission } },
          content: `Landed branch #${id} is still open: its submission ${open.submission} landed, and its run ended with work still under way (a subagent, a reply it waits for or a pending notify). It concludes itself if a later run ends with nothing under way; conclude it now if that work no longer matters.`,
        })
        open.escalated = true
        return false
      }
      delete (await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)].landedOpen
      try {
        await host.need(ConversationsApi).concludeIn(tx, [id], id)
        return true
      } catch (error) {
        host.notice(`Not concluding landed #${id}: ${String(error)}`)
        return false
      }
    }, context)
    if (concluded) await release([id], context)
  }
  type IdleReadBeforeWrites = string
  const startIdleLander = async (tx: Tx, index: WorkspaceIndex, source: IdleReadBeforeWrites) => {
    index.landers[source] = await tx.createTask(
      Lander,
      { source },
      {
        conversationId: index.landerConversations[source],
        ownership: { kind: 'conversation' },
      },
    )
    tasksStartedByThisModule.add(index.landers[source])
  }
  async function ensureLanderBeforeWrites(
    tx: Tx,
    index: WorkspaceIndex,
    source: string,
    target: string,
    pathResolvedBeforeTransaction: string,
  ) {
    const known = index.landerConversations[source]
    if (known !== undefined && (await tx.conversation(known))) {
      ;(await tx.doc(host.metadata, known)).title = '@lander'
      await host.need(ConversationsApi).setStanding(tx, known, true)
      return known
    }
    const lander = (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id
    await configure(tx, lander, { cwd: pathResolvedBeforeTransaction })
    Object.assign(await tx.doc(host.metadata, lander), {
      title: '@lander',
      label: 'lander',
    })
    await host.need(ConversationsApi).setStanding(tx, lander, true)
    index.landerConversations[source] = lander
    return lander
  }
  async function standLander(context: Context) {
    await host.harness().commit(async (tx) => {
      const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
      for (const id of Object.values(index.landerConversations))
        if (await tx.conversation(id)) await host.need(ConversationsApi).setStanding(tx, id, true)
    }, context)
    const checkout = await isolatable(host.projectRoot)
    const { source, target } = 'source' in checkout ? checkout : {}
    const path =
      source &&
      target &&
      (await landerCheckout(host.home, source, await host.projectSettings(), serializeSourceWrites))
    await host.harness().commit(async (tx) => {
      const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
      const landers: ConversationId[] = []
      for (const id of Object.values(index.landerConversations))
        if (await tx.conversation(id)) landers.push(id)
      if (source && target && path) {
        const own = await ensureLanderBeforeWrites(tx, index, source, target, path)
        if (!landers.includes(own)) landers.push(own)
      }
      for (const id of landers)
        await host.need(ConversationsApi).setAutomaticSummaries(tx, id, false)
    }, context)
  }
  async function resume(context: Context) {
    const restarted = await host.harness().commit(async (tx) => {
      const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
      const sources = [...new Set(index.queue.map((item) => item.source))].filter(
        (source) => index.landerConversations[source] !== undefined,
      )
      const stopped: string[] = []
      for (const source of sources) if (await landerIdle(tx, index, source)) stopped.push(source)
      for (const source of stopped) {
        for (const item of index.queue)
          if (item.source === source) {
            item.state = 'queued'
            delete item.step
          }
        await startIdleLander(tx, index, source)
      }
      return stopped.length
    }, context)
    if (restarted) host.harness().resume()
  }
  const get = async (id: ConversationId, context: Context) =>
    (await host.harness().snapshot(Workspaces, ROOT_CONVERSATION_ID, context))?.items[String(id)]
  const Preparation = defineTask<
    { id: ConversationId; reset?: boolean; preserve?: boolean },
    { phase: 'prepare' },
    null
  >({
    name: 'workspaces.prepare',
    version: 1,
    initial: () => ({ phase: 'prepare' }),
    phases: {
      prepare: async (task, runtime, context) => {
        const workspace = (await get(task.input.id, context))!
        let checkoutCreatedByPreparation = false
        try {
          await serializeSourceWrites(workspace.source, async () => {
            const list = async () =>
              (await git(workspace.source, 'worktree', 'list', '--porcelain'))
                .split('\n\n')
                .find((entry) => entry.split('\n').includes(`worktree ${workspace.path}`))
            let registered = await list()
            const pathReservedBeforeCrash = await runtime.memo<boolean>('started', context)
            const settings = await host.projectSettings()
            const reservedAddInterrupted =
              pathReservedBeforeCrash &&
              hasAddCommand(settings) &&
              (registered
                ? !registered.split('\n').includes(`branch refs/heads/${workspace.branch}`)
                : await onDisk(workspace.path))
            if (reservedAddInterrupted) {
              await clearCheckout(workspace.source, workspace.path)
              registered = await list()
            }
            if (registered) {
              if (
                !pathReservedBeforeCrash ||
                !registered.split('\n').includes(`branch refs/heads/${workspace.branch}`)
              )
                throw new Error(`Workspace path already exists: ${workspace.path}`)
            } else {
              if (
                await lstat(workspace.path).catch((error: NodeJS.ErrnoException) => {
                  if (error.code !== 'ENOENT') throw error
                  return undefined
                })
              )
                throw new Error(`Workspace path already exists: ${workspace.path}`)
              if (await git(workspace.source, 'branch', '--list', workspace.branch)) {
                if (
                  !task.input.reset &&
                  (!pathReservedBeforeCrash ||
                    (await git(workspace.source, 'rev-parse', workspace.branch)) !== workspace.base)
                )
                  throw new Error(`Workspace branch already exists: ${workspace.branch}`)
                if (!task.input.reset) await git(workspace.source, 'branch', '-D', workspace.branch)
              }
              await runtime.memo('started', true, context)
              checkoutCreatedByPreparation = true
              await addCheckout(
                settings,
                workspace.source,
                workspace.path,
                treeName(workspace.branch),
                task.input.preserve
                  ? [workspace.branch]
                  : [task.input.reset ? '-B' : '-b', workspace.branch, workspace.base],
              )
            }
          })
          checkoutCreatedByPreparation = true
          await setup(
            workspace.source,
            workspace.path,
            await host.projectSettings(),
            runtime.signal,
          )
          await runtime.commit(async (tx) => {
            ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(task.input.id)].state =
              'ready'
            return { status: 'terminal', outcome: { status: 'completed', result: null } }
          }, context)
        } catch (error) {
          if (runtime.signal.aborted) throw error
          await serializeSourceWrites(workspace.source, async () => {
            const registered = (await git(workspace.source, 'worktree', 'list', '--porcelain'))
              .split('\n\n')
              .find(
                (entry) =>
                  entry.split('\n').includes(`worktree ${workspace.path}`) &&
                  entry.split('\n').includes(`branch refs/heads/${workspace.branch}`),
              )
            if (checkoutCreatedByPreparation) {
              if (registered)
                await removeCheckoutWithoutForce(
                  await host.projectSettings(),
                  workspace.source,
                  workspace.path,
                  treeName(workspace.branch),
                ).catch(overshadowed)
              if (
                !task.input.preserve &&
                (await git(workspace.source, 'rev-parse', workspace.branch).catch(() => '')) ===
                  workspace.base
              )
                await git(workspace.source, 'branch', '-D', workspace.branch).catch(overshadowed)
            }
          })
          await runtime.commit(async (tx) => {
            const saved = (await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[
              String(task.input.id)
            ]
            saved.state = 'failed'
            saved.error = (error instanceof Error ? error.message : String(error)).slice(-4000)
            return { status: 'terminal', outcome: { status: 'completed', result: null } }
          }, context)
        }
      },
    },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const saved = (await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(task.input.id)]
        saved.state = 'failed'
        saved.error = 'Workspace preparation aborted'
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, context),
  })
  async function busy(id: ConversationId, context: Context) {
    if ((await host.harness().snapshot(LiveDoc, id, context))?.run)
      return 'Conversation is running; wait or stop it before landing or removal'
    if ((await host.harness().snapshot(InboxDoc, id, context))?.items.length)
      return 'Conversation has queued input; wait or cancel it first'
    return undefined
  }
  async function idle(id: ConversationId, context: Context) {
    const reason = await busy(id, context)
    if (reason) throw new Error(reason)
  }
  async function candidates(ids: ConversationId[], context: Context) {
    const owned = new Set(ids)
    const parents = new Map<number, number>()
    await host.harness().commit(async (tx) => {
      const rows = []
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanConversations({}, 256, cursor)
        rows.push(...page.items)
        for (const row of page.items) if (row.owner) parents.set(row.id, row.owner.conversationId)
        cursor = page.next
      } while (cursor !== undefined)
      let size: number
      do {
        size = owned.size
        for (const row of rows)
          if (row.owner && owned.has(row.owner.conversationId)) owned.add(row.id)
      } while (size !== owned.size)
    }, context)
    const depth = (id: number): number => {
      let value = 0
      for (let parent = parents.get(id); parent !== undefined; parent = parents.get(parent)) value++
      return value
    }
    return {
      ids: [...owned].toSorted((a, b) => depth(b) - depth(a)),
      parents,
    }
  }
  async function presentCheckout(id: ConversationId, context: Context) {
    const workspace = await get(id, context)
    if (!workspace || !['ready', 'failed', 'removed'].includes(workspace.state)) return undefined
    return (await onDisk(workspace.path)) ? workspace : undefined
  }
  async function recordedCheckout(id: ConversationId, context: Context) {
    const workspace = await presentCheckout(id, context)
    if (!workspace) return undefined
    const registered = await listedBySource(workspace)
    const potentiallyForeignFolder = !registered && workspace.state !== 'ready'
    if (potentiallyForeignFolder) return undefined
    return { workspace, registered }
  }
  async function progress(ids: ConversationId[], context: Context): Promise<KeptWork[]> {
    const result = await Promise.all(
      ids.map(async (id) => {
        const workspace = await get(id, context)
        const readyWithoutGitSpawn =
          workspace?.state === 'ready' && (await onDisk(join(workspace.path, '.git')))
        if (!readyWithoutGitSpawn) return undefined
        return changes(id, workspace).catch(meansNone)
      }),
    )
    return result.filter((item) => item !== undefined)
  }
  async function pending(ids: ConversationId[], context: Context): Promise<KeptWork[]> {
    const result: KeptWork[] = []
    for (const id of (await candidates(ids, context)).ids) {
      const checkout = await recordedCheckout(id, context)
      if (!checkout?.registered) continue
      const item = await changes(id, checkout.workspace)
      if (item.uncommitted || item.unlanded) result.push(item)
    }
    return result
  }
  async function finishRemoval(
    id: ConversationId,
    workspace: WorkspaceIndex['items'][string],
    context: Context,
  ) {
    let item: KeptWork = { id, uncommitted: 0, unlanded: 0 }
    try {
      if (await listedBySource(workspace)) {
        item = { id, ...(await workLostWithCheckout(workspace)) }
        if (item.uncommitted || item.unlanded) {
          await host.harness().commit(async (tx) => {
            ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)].state = 'ready'
          }, context)
          return item
        }
        await removeCheckoutWithoutForce(
          await host.projectSettings(),
          workspace.source,
          workspace.path,
          treeName(workspace.branch),
        )
      } else if (await onDisk(workspace.path)) {
        if (!(await onlyIgnored(workspace)))
          throw new Error(`Workspace path is not a registered checkout: ${workspace.path}`)
        await rm(workspace.path, { recursive: true, force: true })
      }
      if (await git(workspace.source, 'branch', '--list', workspace.branch)) {
        const merged = await git(
          workspace.source,
          'merge-base',
          '--is-ancestor',
          workspace.branch,
          workspace.target,
        ).then(
          () => true,
          () => false,
        )
        if (merged) await git(workspace.source, 'branch', '-D', workspace.branch)
      }
      return undefined
    } catch (error) {
      const reason = failure(error)
      const present = await registeredCheckout(workspace)
      await host.harness().commit(async (tx) => {
        const saved = (await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)]
        saved.state = present ? 'ready' : 'removed'
        saved.error = reason
      }, context)
      return { ...item, reason }
    }
  }

  async function release(
    ids: ConversationId[],
    context: Context,
    signal?: AbortSignal,
  ): Promise<KeptWork[]> {
    const kept: KeptWork[] = []
    if (signal?.aborted) return kept
    const graph = await candidates(ids, context)
    const retained = new Map<number, number>()
    for (const id of graph.ids) {
      if (signal?.aborted) break
      const record = await get(id, context)
      if (!record) continue
      await serializeSourceWrites(record.source, async () => {
        if (signal?.aborted) return
        const workspace = (await get(id, context))!
        if (workspace.state === 'preparing') {
          kept.push({ id, uncommitted: 0, unlanded: 0, busy: 'Workspace is preparing' })
          return
        }
        const checkout = await recordedCheckout(id, context)
        const present = Boolean(checkout)
        const registered = Boolean(checkout?.registered)
        const item: KeptWork = present
          ? await workHeldByRegisteredCheckout(id, workspace, registered)
          : { id, uncommitted: 0, unlanded: 0 }
        if (retained.has(id)) item.descendant = retained.get(id)
        const reason = await host.harness().commit(async (tx) => {
          const live = await tx.doc(LiveDoc, id)
          const inbox = await tx.doc(InboxDoc, id)
          const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
          delete index.items[String(id)].landedOpen
          if (live.run) return 'Conversation is running; wait or stop it before removal'
          if (inbox.items.length) return 'Conversation has queued input; wait or cancel it first'
          const sources = new Set([workspace.path])
          let size: number
          do {
            size = sources.size
            for (const [child, descendant] of Object.entries(index.items)) {
              if (!sources.has(descendant.source)) continue
              sources.add(descendant.path)
              if (descendant.state !== 'removed') item.descendant = Number(child)
            }
          } while (size !== sources.size)
          if (!item.uncommitted && !item.unlanded && !item.reason && !item.descendant)
            index.items[String(id)].state = 'removed'
          else if (registered && index.items[String(id)].state === 'removed')
            index.items[String(id)].state = 'ready'
          return undefined
        }, context)
        if (reason) item.busy = reason
        if (item.uncommitted || item.unlanded || item.reason || item.busy || item.descendant) {
          kept.push(item)
          return
        }
        using external = await host.want(ExternalSessions)?.stop([id])
        void external
        if (
          !present &&
          !(await lstat(workspace.source).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
            return undefined
          }))
        )
          return
        if (present && !registered) await rm(workspace.path, { recursive: true, force: true })
        const remaining = await finishRemoval(id, workspace, context)
        if (remaining) kept.push(remaining)
      })
      if (kept.some((item) => item.id === id))
        for (
          let parent = graph.parents.get(id);
          parent !== undefined;
          parent = graph.parents.get(parent)
        )
          retained.set(parent, id)
    }
    return kept
  }
  async function sweep(context: Context, signal?: AbortSignal) {
    const directory = join(host.home, 'worktrees')
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    if (!names.length) return []
    const checkout = await isolatable(host.projectRoot)
    if ('reason' in checkout) return []
    const { source, target } = checkout
    const index = await host.harness().snapshot(Workspaces, ROOT_CONVERSATION_ID, context)
    const recordedAndLanderPaths = new Set([
      ...Object.values(index?.items ?? {}).map((workspace) => workspace.path),
      ...(await Promise.all(
        [...new Set([source, ...Object.keys(index?.landerConversations ?? {})])].map(
          async (lander) => landerPath(host.home, lander, await host.projectSettings()),
        ),
      )),
    ])
    const root = await realpath(directory)
    const kept: string[] = []
    for (const name of names) {
      if (signal?.aborted) break
      const path = join(root, name)
      if (recordedAndLanderPaths.has(path)) continue
      await serializeSourceWrites(source, async () => {
        const record = (await git(source, 'worktree', 'list', '--porcelain'))
          .split('\n\n')
          .map((lines) => lines.split('\n'))
          .find((lines) => lines[0] === `worktree ${path}`)
        if (!record) return
        const branch = record
          .find((line) => line.startsWith('branch refs/heads/'))
          ?.slice('branch refs/heads/'.length)
        const work = await workLostWithCheckout({ path, branch: branch ?? '', target }).catch(
          (error: unknown) => ({ uncommitted: 0, unlanded: 0, reason: failure(error) }),
        )
        if (work.uncommitted || work.unlanded || work.reason) {
          kept.push(path)
          return
        }
        await git(source, 'worktree', 'remove', path)
        if (branch && (await contains(source, branch, target)))
          await git(source, 'branch', '-D', branch)
      })
    }
    if (kept.length)
      host.notice(`Kept ${kept.length} unrecorded worktrees with changes: ${kept.join(', ')}`)
    return kept
  }
  async function land(id: ConversationId, context: Context): Promise<LandResult> {
    const record = await get(id, context)
    if (!record) throw new Error('Conversation has no workspace')
    return serializeSourceWrites(record.source, async () => {
      const workspace = (await get(id, context))!
      const source = workspace.source
      await idle(id, context)
      if (workspace.state !== 'ready') throw new Error(`Workspace is ${workspace.state}`)
      const dirty = await git(workspace.path, 'status', '--porcelain')
      if (dirty) throw new Error(`Worktree is dirty:\n${dirty}`)
      if (
        (await git(source, 'symbolic-ref', '--short', 'HEAD').catch(() => '')) !== workspace.target
      )
        throw new Error(`Target branch changed; check out ${workspace.target} first`)
      if ((await git(workspace.path, 'symbolic-ref', '--short', 'HEAD')) !== workspace.branch)
        throw new Error('Workspace branch changed')
      const tip = await git(workspace.path, 'rev-parse', 'HEAD')
      const head = await git(source, 'rev-parse', 'HEAD')
      const integrated = await git(source, 'merge-base', '--is-ancestor', tip, head).then(
        () => true,
        () => false,
      )
      let result: LandResult = {
        text: 'Nothing to land.',
        landed: tip,
        commits: [],
        paths: [],
        files: [],
      }
      if (!integrated) {
        if (
          !(await git(source, 'merge-base', '--is-ancestor', head, tip).then(
            () => true,
            () => false,
          ))
        )
          throw new Error(
            `Target moved or diverged; update the workspace onto ${workspace.target} and verify again`,
          )
        const commits = (await git(workspace.path, 'log', '--oneline', `${head}..${tip}`))
          .split('\n')
          .filter(Boolean)
        const files = (await git(workspace.path, 'diff', '--numstat', '--no-renames', head, tip))
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [addedOrBinaryDash, removedOrBinaryDash, path] = line.split('\t')
            return {
              path,
              added: Number(addedOrBinaryDash) || 0,
              removed: Number(removedOrBinaryDash) || 0,
            }
          })
        const needsRestart =
          (await realpath(source)) === (await realpath(host.ultimateRoot)) &&
          restartNeeded(files.map((file) => file.path))
        await git(source, 'merge', '--ff-only', tip)
        result = {
          text: `Landed commits:\n${commits.join('\n')}\nChanged files:\n${files.map((file) => `${file.path} +${file.added} -${file.removed}`).join('\n')}${needsRestart ? '\nNeeds restart.' : ''}`,
          landed: tip,
          commits,
          paths: files.map((file) => file.path),
          files,
          ...(needsRestart ? { needsRestart: true } : {}),
        }
      }
      await host.harness().commit(async (tx) => {
        ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)].landed = tip
      }, context)
      return result
    })
  }
  async function submit(
    id: ConversationId,
    divergence: string,
    context: Context,
  ): Promise<SubmitResult> {
    if (!divergence?.trim())
      throw new Error(
        "Submitting requires divergence: describe changes from the original request, or say 'None'.",
      )
    divergence = divergence.trim()
    const workspace = await get(id, context)
    if (!workspace) throw new Error('Conversation has no workspace')
    if (workspace.state !== 'ready') throw new Error(`Workspace is ${workspace.state}`)
    const dirty = await git(workspace.path, 'status', '--porcelain')
    if (dirty) throw new Error(`Worktree is dirty:\n${dirty}`)
    if ((await git(workspace.path, 'symbolic-ref', '--short', 'HEAD')) !== workspace.branch)
      throw new Error('Workspace branch changed')
    const tip = await git(workspace.path, 'rev-parse', 'HEAD')
    const path = await landerPath(host.home, workspace.source, await host.projectSettings())
    const subject = await host.need(ConversationsApi).subject(id, context)
    const result = await host.harness().commit(async (tx) => {
      const row = await tx.conversation(id)
      if (!row || row.owner)
        throw new Error('Only a top-level main conversation submits its own workspace')
      const at = (await tx.scanEntries({ conversationId: id }, 1)).items[0]?.id
      if (at === undefined)
        throw new Error('Submitting requires a conversation entry for its breadcrumb')
      const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
      const { source, target } = index.items[String(id)]
      const idleReadBeforeWrites = await landerIdle(tx, index, source)
      const lander = await ensureLanderBeforeWrites(tx, index, source, target, path)
      const queued = index.queue.find(
        (item) => item.conversationId === id && item.tip === tip && item.state === 'queued',
      )
      const entry = queued ?? {
        id: `${id}-${tip.slice(0, 7)}-${Date.now().toString(36)}`,
        conversationId: id,
        source,
        target,
        tip,
        at,
        divergence,
        state: 'queued' as const,
        ...(subject ? { subject } : {}),
        steps: [],
      }
      if (!queued) {
        await log(tx, lander, entry, { step: 'queued' })
        index.queue.push(entry)
        delete index.items[String(id)].landedOpen
      }
      if (idleReadBeforeWrites) await startIdleLander(tx, index, source)
      const position = index.queue
        .filter((item) => item.source === source)
        .findIndex((item) => item.id === entry.id)
      return {
        id: entry.id,
        position: position + 1,
        lander,
        text: `Submitted ${tip.slice(0, 7)} as ${entry.id}, position ${position + 1} in the ${target} queue. A failure comes back here; a landing reaches whoever started you and concludes you unless work is still under way. Log: lander conversation #${lander}.`,
      }
    }, context)
    host.harness().resume()
    return result
  }
  async function unavailable(id: ConversationId, context: Context) {
    let workspace = await get(id, context)
    if (!workspace) return undefined
    if (workspace.state === 'failed') {
      const kept = await ready(id, context, true)
      if (kept) return `Workspace setup failed and its checkout keeps changes: ${kept.reason ?? ''}`
      workspace = (await get(id, context))!
      if (workspace.state === 'failed')
        return `Workspace setup failed: ${workspace.error}; fix the cause, then call a tool again to retry the setup`
    }
    if (workspace.state === 'removed') {
      const kept = await ready(id, context)
      if (kept) return `Workspace is removed: ${kept.reason ?? 'its checkout keeps changes'}`
      workspace = (await get(id, context))!
    }
    if (workspace.state !== 'ready')
      return `Workspace is ${workspace.state}: ${workspace.error ?? 'checkout is not ready; send a new input to retry'}`
    if (!(await registeredCheckout(workspace)))
      return `Workspace checkout is missing or unregistered: ${workspace.path}${workspace.error ? `; ${workspace.error}` : ''}`
    return undefined
  }
  async function ready(
    id: ConversationId,
    context: Context,
    retryFailed = false,
  ): Promise<KeptWork | undefined> {
    const record = await get(id, context)
    if (!record) return undefined
    const harness = host.harness()
    const index = await harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context)
    const parent = Object.entries(index?.items ?? {}).find(
      ([, workspace]) => workspace.path === record.source,
    )?.[0]
    const recreate = () =>
      serializeSourceWrites(record.source, async () => {
        if (parent && (await get(parseConversationId(Number(parent)), context))?.state !== 'ready')
          return true
        const workspace = (await get(id, context))!
        if (workspace.state === 'ready' && !(await presentCheckout(id, context))) {
          await harness.commit(async (tx) => {
            ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)].state = 'removed'
          }, context)
        } else if (
          workspace.state !== 'removed' &&
          !(
            retryFailed &&
            workspace.state === 'failed' &&
            !(await lstat(workspace.path).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error
              return undefined
            }))
          )
        )
          return false
        const remaining = await finishRemoval(id, workspace, context)
        if (remaining) return remaining
        const exists = Boolean(await git(workspace.source, 'branch', '--list', workspace.branch))
        const preserve =
          exists &&
          !(await git(
            workspace.source,
            'merge-base',
            '--is-ancestor',
            workspace.branch,
            workspace.target,
          ).then(
            () => true,
            () => false,
          ))
        const base = await git(
          workspace.source,
          'rev-parse',
          preserve ? workspace.branch : workspace.target,
        )
        return harness.commit(async (tx) => {
          const savedIndex = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
          if (parent) {
            const source = savedIndex.items[parent]
            if (
              source.state !== 'ready' ||
              !(await lstat(source.path).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'ENOENT') throw error
                return undefined
              }))
            )
              return true
          }
          const saved = savedIndex.items[String(id)]
          saved.base = base
          saved.state = 'preparing'
          delete saved.error
          delete saved.landed
          await tx.createTask(
            Preparation,
            { id, reset: true, preserve },
            { conversationId: id, ownership: { kind: 'conversation' }, background: true },
          )
          return false
        }, context)
      })
    let retry: boolean | KeptWork
    do {
      if (parent) {
        const parentId = parseConversationId(Number(parent))
        await ready(parentId, context)
        const source = (await get(parentId, context))!
        if (source.state === 'failed')
          throw new Error(`Source workspace #${parent} setup failed: ${source.error}`)
        retry = await serializeSourceWrites(source.source, recreate)
      } else retry = await recreate()
    } while (retry === true)
    if (typeof retry === 'object') return retry
    if ((await get(id, context))?.state !== 'preparing') return undefined
    harness.resume()
    const task = await harness.commit(
      async (tx) =>
        (
          await tx.scanTasks(
            { conversationId: id, kind: Preparation.definition.name, order: 'descending' },
            1,
          )
        ).items[0],
      context,
    )
    if (task) await harness.waitForTask(task.id, context)
    return undefined
  }
  return {
    Preparation,
    Lander,
    resume,
    standLander,
    started: tasksStartedByThisModule,
    get,
    unavailable,
    land,
    submit,
    pending,
    progress,
    release,
    settleLanded,
    sweep,
    async create(tx: Tx, id: ConversationId, cwd: string) {
      if (
        !host.extensions().some((extension) => extension.name === 'workspaces' && extension.enabled)
      )
        throw new Error('Enable workspaces to create an isolated conversation')
      const checkout = await isolatable(cwd)
      if ('reason' in checkout) throw new Error(checkout.reason)
      const { source, target } = checkout
      const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
      if (index.items[String(id)]) throw new Error('Conversation already has a workspace')
      const branch = `ultimate/${createHash('sha256').update(host.home).digest('hex').slice(0, 6)}-${id}`
      let path = await treePath(await host.projectSettings(), treeName(branch))
      if (!path) {
        await mkdir(join(host.home, 'worktrees'), { recursive: true })
        path = join(await realpath(join(host.home, 'worktrees')), String(id))
      }
      index.items[String(id)] = {
        path,
        branch,
        base: await git(source, 'rev-parse', `refs/heads/${target}`),
        source,
        target,
        state: 'preparing',
      }
      const repositoryRelativeCwd = relative(source, await realpath(cwd))
      await configure(tx, id, {
        cwd:
          repositoryRelativeCwd === '..' ||
          repositoryRelativeCwd.startsWith(`..${sep}`) ||
          isAbsolute(repositoryRelativeCwd)
            ? path
            : join(path, repositoryRelativeCwd),
      })
      await tx.createTask(
        Preparation,
        { id },
        { conversationId: id, ownership: { kind: 'conversation' }, background: true },
      )
      return index.items[String(id)]
    },
    ready,
    async info(id: ConversationId, context: Context): Promise<WorkspaceInfo | null> {
      const workspace = await get(id, context)
      if (!workspace) return null
      return {
        ...workspace,
        ahead: await git(workspace.source, 'rev-list', '--count', `HEAD..${workspace.branch}`).then(
          Number,
          () => null,
        ),
        tip: await git(workspace.path, 'rev-parse', 'HEAD').catch(() => null),
        sourceTip: await git(workspace.source, 'rev-parse', 'HEAD').catch(() => null),
        currentBranch: await git(workspace.path, 'symbolic-ref', '--short', 'HEAD').catch(
          () => null,
        ),
        sourceBranch: await git(workspace.source, 'symbolic-ref', '--short', 'HEAD').catch(
          () => null,
        ),
      }
    },
    async discard(id: ConversationId, context: Context) {
      const record = await get(id, context)
      if (!record) throw new Error('Conversation has no workspace')
      return serializeSourceWrites(record.source, async () => {
        const workspace = (await get(id, context))!
        await idle(id, context)
        if (workspace.state === 'preparing') throw new Error('Workspace is preparing')
        if (workspace.state !== 'removed') {
          using external = await host.want(ExternalSessions)?.stop([id])
          void external
          if (await listedBySource(workspace))
            await removeCheckoutWithoutForce(
              await host.projectSettings(),
              workspace.source,
              workspace.path,
              treeName(workspace.branch),
            )
          await host.harness().commit(async (tx) => {
            ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)].state = 'removed'
          }, context)
        }
        return { text: `Discarded isolate; kept branch ${workspace.branch}.` }
      })
    },
    async stats(context: Context): Promise<WorkspaceStats> {
      const items = Object.values(
        (await host.harness().snapshot(Workspaces, ROOT_CONVERSATION_ID, context))?.items ?? {},
      )
      const stats: WorkspaceStats = {
        total: items.length,
        ready: 0,
        preparing: 0,
        failed: 0,
        removed: 0,
        landed: 0,
        ahead: 0,
        fresh: 0,
        dirty: 0,
      }
      for (const workspace of items) stats[workspace.state]++
      const gitProcessesAtOnce = 8
      const queue = items.filter((workspace) => workspace.state === 'ready').values()
      await Promise.all(
        Array.from({ length: gitProcessesAtOnce }, async () => {
          for (const workspace of queue) {
            const tip = await git(workspace.path, 'rev-parse', 'HEAD').catch(() => '')
            if (await git(workspace.path, 'status', '--porcelain').catch(() => '')) stats.dirty++
            if (!tip || tip === workspace.base) stats.fresh++
            else if (
              await git(
                workspace.source,
                'merge-base',
                '--is-ancestor',
                tip,
                `refs/heads/${workspace.target}`,
              ).then(
                () => true,
                () => false,
              )
            )
              stats.landed++
            else stats.ahead++
          }
        }),
      )
      return stats
    },
    disk(): Promise<WorkspaceDisk> {
      const diskMeasurementCacheMs = 60_000
      if (disk.last && Date.now() - disk.last.at < diskMeasurementCacheMs)
        return Promise.resolve(disk.last)
      if (disk.running) return disk.running
      const directory = join(host.home, 'worktrees')
      const promise: Promise<WorkspaceDisk> = Promise.all([
        exec('du', ['-sk', directory], { timeout: 120_000 }).then(
          ({ stdout }) => Number(stdout.split('\t')[0]) * 1024,
          () => null,
        ),
        exec('btrfs', ['filesystem', 'du', '-s', '--raw', directory], {
          timeout: 120_000,
        }).then(
          ({ stdout }) => {
            const [, exclusiveBytes, sharedBytesCountedOnce] = stdout
              .trim()
              .split('\n')
              .at(-1)!
              .trim()
              .split(/\s+/)
            return Number(exclusiveBytes) + Number(sharedBytesCountedOnce)
          },
          () => null,
        ),
      ])
        .then(([bytes, real]) => (disk.last = { bytes, real, at: Date.now() }))
        .finally(() => (disk.running = undefined))
      disk.running = promise
      return promise
    },
  }
}
