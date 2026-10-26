import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@earendil-works/chord'
import {
  configure,
  defineDoc,
  defineTask,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, TaskId, Tx } from '@earendil-works/pi-durable'
import { exec } from '../../lib/exec.ts'
import { git, isolatable } from '../../lib/git.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { WorkspacesDoc } from './refs.ts'
import { removeWorktree } from './remove.ts'
import { setup } from './setup.ts'
import { cloneMode, populate } from './clone.ts'
import { createLander, landerAgent, landerCheckout, landerPath, log } from './lander.ts'
import type {
  LandResult,
  SubmitResult,
  WorkspaceIndex,
  WorkspaceDisk,
  WorkspaceInfo,
  WorkspaceStats,
} from './types.ts'
import type { KeptWork } from '../conversations/types.ts'

export const Workspaces = defineDoc<WorkspaceIndex>({
  kind: WorkspacesDoc.kind,
  checkpointWhen: () => false,
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
    // Version 4 records each submission's steps; earlier ones start without.
    const index = value as WorkspaceIndex
    return {
      ...index,
      queue: index.queue.map((item) => ({ ...item, steps: [] })),
      results: Object.fromEntries(
        Object.entries(index.results).map(([id, result]) => [
          id,
          { ...result, tip: id.split('-')[1], steps: [] },
        ]),
      ),
    }
  },
})
/**
 * Lander tasks started by this version of the code. A reload that changes it imports this module anew with an empty
 * set, so a fault of a task outside it is the previous code's.
 */
const started = new Set<number>()
/** Whether `source` has no live lander task: none recorded, or one that ended (finished, faulted, aborted). */
async function landerIdle(tx: Tx, index: WorkspaceIndex, source: string) {
  const running = index.landers[source]
  const live = running === undefined ? undefined : await tx.task(running as TaskId)
  return !live || live.state.status === 'terminal' || live.state.status === 'completing'
}
type Host = Pick<
  ExtensionHost,
  | 'harness'
  | 'home'
  | 'ultimateRoot'
  | 'projectRoot'
  | 'userHome'
  | 'modelRuntime'
  | 'settings'
  | 'projectSettings'
  | 'need'
  | 'want'
  | 'resource'
  | 'extensions'
  | 'metadata'
  | 'notice'
  | 'emit'
>
async function changes(
  id: ConversationId,
  workspace: WorkspaceIndex['items'][string],
): Promise<KeptWork> {
  return {
    id,
    // Untracked files count whatever status.showUntrackedFiles says.
    uncommitted: (await git(workspace.path, 'status', '--porcelain', '--untracked-files=all'))
      .split('\n')
      .filter(Boolean).length,
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
/**
 * The work a recorded checkout folder holds. A registered checkout has its changes and commits; a folder Git no longer
 * lists as a worktree (ignored files left after `git worktree remove`) is not a repository to inspect, so only its
 * branch's unlanded commits count, and those live in the source.
 */
async function held(
  id: ConversationId,
  workspace: WorkspaceIndex['items'][string],
  registered: boolean,
): Promise<KeptWork> {
  if (registered) return changes(id, workspace)
  const branch =
    (await onDisk(workspace.source)) &&
    Boolean(await git(workspace.source, 'branch', '--list', workspace.branch))
  return {
    id,
    uncommitted: 0,
    unlanded: branch
      ? Number(
          await git(
            workspace.source,
            'rev-list',
            '--count',
            `${workspace.target}..${workspace.branch}`,
          ),
        )
      : 0,
  }
}
/** Whether the source lists the path as a worktree; throws when the source cannot tell, so callers never guess. */
async function listedBySource(workspace: WorkspaceIndex['items'][string]) {
  return (await git(workspace.source, 'worktree', 'list', '--porcelain'))
    .split('\n\n')
    .some((entry) => entry.split('\n').includes(`worktree ${workspace.path}`))
}
async function registeredCheckout(workspace: WorkspaceIndex['items'][string]) {
  if (!(await onDisk(workspace.path))) return false
  const listed = await git(workspace.path, 'worktree', 'list', '--porcelain').catch(
    // A folder Git cannot inspect is not a usable registered checkout.
    () => '',
  )
  return listed
    .split('\n\n')
    .some((entry) => entry.split('\n').includes(`worktree ${workspace.path}`))
}
export function workspaces(host: Host) {
  const queues = host.resource('workspaces.land', () => new Map<string, Promise<unknown>>())
  /** Runs writes to one source checkout one at a time, across synchronous landing and the lander. */
  async function serial<T>(source: string, operation: () => Promise<T>): Promise<T> {
    const queued = (queues.get(source) ?? Promise.resolve())
      .catch(
        // The previous caller receives its failure; it must not poison the next queued operation.
        () => undefined,
      )
      .then(operation)
    queues.set(source, queued)
    try {
      return await queued
    } finally {
      if (queues.get(source) === queued) queues.delete(source)
    }
  }
  const disk = host.resource(
    'workspaces.disk',
    (): { last?: WorkspaceDisk; running?: Promise<WorkspaceDisk> } => ({}),
  )
  const Lander = createLander(host, Workspaces, serial)
  /** Start the lander task of `source` in its lander conversation. Call only after `landerIdle`, before any write. */
  const startLander = async (tx: Tx, index: WorkspaceIndex, source: string) => {
    // Not background: the task is the lander conversation's work, so it shows as working while it lands.
    index.landers[source] = await tx.createTask(
      Lander,
      { source },
      {
        conversationId: index.landerConversations[source] as ConversationId,
        ownership: { kind: 'conversation' },
      },
    )
    started.add(index.landers[source])
  }
  /**
   * The lander conversation of `source`, created once with title "@lander" and label `lander`, and marked standing so
   * it is never concluded; its cwd is the lander's checkout. Reads before writes, as a transaction requires: call it
   * before anything else writes.
   */
  async function ensureLander(
    tx: Tx,
    index: WorkspaceIndex,
    source: string,
    target: string,
    /** `landerPath()` of `source`, resolved before the transaction. */
    path: string,
  ) {
    const known = index.landerConversations[source] as ConversationId | undefined
    if (known !== undefined && (await tx.conversation(known))) {
      ;(await tx.doc(host.metadata, known)).title = '@lander'
      await host.need(ConversationsApi).setStanding(tx, known, true)
      return known
    }
    const lander = (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id
    await configure(tx, lander, { cwd: path })
    Object.assign(await tx.doc(host.metadata, lander), {
      title: '@lander',
      label: 'lander',
    })
    await host.need(ConversationsApi).setStanding(tx, lander, true)
    index.landerConversations[source] = lander
    return lander
  }
  /**
   * Make sure the project's checkout has its lander conversation, configured from the effective `lander` definition;
   * every lander conversation follows the definition as it is now. Idempotent; a project that cannot be isolated (outside
   * Git, or before its first commit) has none until it can.
   */
  async function standLander(context: Context) {
    // Landers stay standing even when preparing the checkout below fails.
    await host.harness().commit(async (tx) => {
      const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
      for (const id of Object.values(index.landerConversations) as ConversationId[])
        if (await tx.conversation(id)) await host.need(ConversationsApi).setStanding(tx, id, true)
    }, context)
    const checkout = await isolatable(host.projectRoot)
    const { source, target } = 'source' in checkout ? checkout : {}
    const { change } = await landerAgent(host, context)
    // The conversation's cwd exists from the start, at the target tip, so it can answer before any submission.
    const path = source && target && (await landerCheckout(host.home, source))
    await host.harness().commit(async (tx) => {
      const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
      const landers: ConversationId[] = []
      for (const id of Object.values(index.landerConversations) as ConversationId[])
        if (await tx.conversation(id)) landers.push(id)
      if (source && target && path) {
        const own = await ensureLander(tx, index, source, target, path)
        if (!landers.includes(own)) landers.push(own)
      }
      for (const id of landers) {
        await configure(tx, id, change)
        // A lander keeps its `@lander` title: no automatic summaries.
        await host.need(ConversationsApi).setAutomaticSummaries(tx, id, false)
      }
    }, context)
  }
  /**
   * Restart the lander of every source whose queue holds submissions but whose task ended without draining it, as a
   * task faulted by a reload of this code does. Idempotent: a source with a live task keeps it.
   */
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
        await startLander(tx, index, source)
      }
      return stopped.length
    }, context)
    if (restarted) host.harness().resume()
  }
  /**
   * Why a tool call in conversation `id` must not run: it is a lander conversation whose task owns the checkout for a
   * submission, and the call is not part of that task's own run on the submission's failure.
   */
  async function landerOwnsCheckout(id: ConversationId, context: Context) {
    const harness = host.harness()
    const index = await harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context)
    const source = Object.entries(index?.landerConversations ?? {}).find(
      ([, lander]) => lander === id,
    )?.[0]
    const entry = index?.queue.find((item) => item.source === source && item.state === 'landing')
    if (!entry) return undefined
    if (entry.agent)
      for (const input of (await harness.snapshot(LiveDoc, id, context))?.run?.inputs ?? [])
        if (
          (
            await (await harness.submission(input, context))?.status(context)
          )?.requestId?.startsWith(`lander-agent:${entry.id}:`)
        )
          return undefined
    return `The lander is landing #${entry.conversationId}; ask again when it is idle`
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
        let created = false
        let populated = false
        try {
          const settings = await host.projectSettings()
          const mode = cloneMode(settings)
          // Git reads every `.git/worktrees/<name>` on list and add, and fails on one a concurrent add has only half
          // written ("failed to read .git/worktrees/<name>/locked"), so preparations of one source take turns.
          await serial(workspace.source, async () => {
            const registered = (await git(workspace.source, 'worktree', 'list', '--porcelain'))
              .split('\n\n')
              .find((entry) => entry.split('\n').includes(`worktree ${workspace.path}`))
            const resumed = await runtime.memo<boolean>('started', context)
            if (registered) {
              if (
                !resumed ||
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
                  (!resumed ||
                    (await git(workspace.source, 'rev-parse', workspace.branch)) !== workspace.base)
                )
                  throw new Error(`Workspace branch already exists: ${workspace.branch}`)
                if (!task.input.reset) await git(workspace.source, 'branch', '-D', workspace.branch)
              }
              await runtime.memo('started', true, context)
              created = true
              await git(
                workspace.source,
                'worktree',
                'add',
                '--no-checkout',
                ...(task.input.preserve
                  ? [workspace.path, workspace.branch]
                  : [
                      task.input.reset ? '-B' : '-b',
                      workspace.branch,
                      workspace.path,
                      workspace.base,
                    ]),
              )
            }
          })
          created = true
          // A crash mid-clone leaves the registered checkout half filled; populate starts over by clearing it.
          populated = (await runtime.memo<boolean>('populated', context)) ?? false
          if (!populated) {
            const result = await populate(workspace.source, workspace.path, mode)
            if (result.reason)
              host.notice(
                `Worktree ${workspace.path} used ${result.backend} checkout: ${result.reason}`,
              )
            await runtime.memo('populated', true, context)
            populated = true
          }
          await setup(workspace.source, workspace.path, settings, runtime.signal)
          await runtime.commit(async (tx) => {
            ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(task.input.id)].state =
              'ready'
            return { status: 'terminal', outcome: { status: 'completed', result: null } }
          }, context)
        } catch (error) {
          if (runtime.signal.aborted) throw error
          await serial(workspace.source, async () => {
            // Remove only the registered checkout created for this record, never an existing path.
            const registered = (await git(workspace.source, 'worktree', 'list', '--porcelain'))
              .split('\n\n')
              .find(
                (entry) =>
                  entry.split('\n').includes(`worktree ${workspace.path}`) &&
                  entry.split('\n').includes(`branch refs/heads/${workspace.branch}`),
              )
            if (created) {
              if (registered)
                // A half-filled copy has no index and looks dirty but holds nothing of its own, so it is forced;
                // once populated, Git's refusal keeps a failed setup's dirty output.
                await git(
                  workspace.source,
                  'worktree',
                  'remove',
                  ...(populated ? [] : ['--force']),
                  workspace.path,
                ).catch(
                  // Best-effort rollback: the preparation error is recorded below and must not be replaced.
                  () => undefined,
                )
              if (
                !task.input.preserve &&
                (await git(workspace.source, 'rev-parse', workspace.branch).catch(() => '')) ===
                  workspace.base
              )
                // Best-effort rollback: the preparation error is recorded below and must not be replaced.
                await git(workspace.source, 'branch', '-D', workspace.branch).catch(() => undefined)
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
  async function idle(id: ConversationId, context: Context, own = false) {
    const reason = !own && (await busy(id, context))
    if (reason) throw new Error(reason)
  }
  async function candidates(ids: number[], context: Context) {
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
      ids: ([...owned] as ConversationId[]).toSorted((a, b) => depth(b) - depth(a)),
      parents,
    }
  }
  async function presentCheckout(id: ConversationId, context: Context) {
    const workspace = await get(id, context)
    if (!workspace || !['ready', 'failed', 'removed'].includes(workspace.state)) return undefined
    return (await onDisk(workspace.path)) ? workspace : undefined
  }
  /**
   * The checkout recorded for `id` that release would act on: a registered worktree, or the leftover folder of one Git
   * already removed (ignored files such as `.wrangler/` after `git worktree remove`) while a ready record still claims
   * it. Registration is read from the source, and a failure to read it throws, so a folder whose own `.git` is broken
   * never counts as a leftover. A removed or failed record's unregistered folder may be someone else's.
   */
  async function recordedCheckout(id: ConversationId, context: Context) {
    const workspace = await presentCheckout(id, context)
    if (!workspace) return undefined
    const registered = await listedBySource(workspace)
    if (!registered && workspace.state !== 'ready') return undefined
    return { workspace, registered }
  }
  /** The commits and uncommitted changes of each ready worktree among `ids`, without their subagents'. */
  async function progress(ids: number[], context: Context): Promise<KeptWork[]> {
    const result = await Promise.all(
      ids.map(async (id) => {
        const workspace = await get(id as ConversationId, context)
        if (workspace?.state !== 'ready' || !(await registeredCheckout(workspace))) return undefined
        return changes(id as ConversationId, workspace).catch(
          // A checkout gone from disk or mid-removal has nothing to show.
          () => undefined,
        )
      }),
    )
    return result.filter((item) => item !== undefined)
  }
  async function pending(ids: number[], context: Context): Promise<KeptWork[]> {
    const result: KeptWork[] = []
    for (const id of (await candidates(ids, context)).ids) {
      const checkout = await recordedCheckout(id, context)
      if (!checkout) continue
      const item = await held(id, checkout.workspace, checkout.registered)
      if (item.uncommitted || item.unlanded) result.push(item)
    }
    return result
  }
  /** Finish an interrupted removal, or keep newly found work and make the checkout usable again. */
  async function finishRemoval(
    id: ConversationId,
    workspace: WorkspaceIndex['items'][string],
    context: Context,
  ) {
    let item: KeptWork = { id, uncommitted: 0, unlanded: 0 }
    try {
      if (await listedBySource(workspace)) {
        item = await changes(id, workspace)
        if (item.uncommitted || item.unlanded) {
          await host.harness().commit(async (tx) => {
            ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)].state = 'ready'
          }, context)
          return item
        }
        if (
          (await git(workspace.path, 'rev-parse', 'HEAD')) !==
          (await git(workspace.source, 'rev-parse', workspace.branch))
        )
          throw new Error(`Workspace #${id} no longer checks out its recorded branch tip`)
        // Git refuses uncommitted changes made since the status check; removeWorktree forces only past submodules
        // that hold nothing unique, after checking the checkout again.
        await removeWorktree(workspace.source, workspace.path)
      } else if (await onDisk(workspace.path))
        // Release clears the leftover folder of its own checkout first; any other folder there is not ours to remove.
        throw new Error(`Workspace path is not a registered checkout: ${workspace.path}`)
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
      // A removal refused earlier, for example for submodule work, left its reason on the record.
      await host.harness().commit(async (tx) => {
        const saved = (await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)]
        saved.state = 'removed'
        delete saved.error
      }, context)
      return undefined
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
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
    ids: number[],
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
      await serial(record.source, async () => {
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
          ? await held(id, workspace, registered)
          : { id, uncommitted: 0, unlanded: 0 }
        if (retained.has(id)) item.descendant = retained.get(id)
        const reason = await host.harness().commit(async (tx) => {
          const live = await tx.doc(LiveDoc, id)
          const inbox = await tx.doc(InboxDoc, id)
          const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
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
          if (!item.uncommitted && !item.unlanded && !item.descendant)
            index.items[String(id)].state = 'removed'
          else if (registered && index.items[String(id)].state === 'removed')
            index.items[String(id)].state = 'ready'
          return undefined
        }, context)
        if (reason) item.busy = reason
        if (item.uncommitted || item.unlanded || item.busy || item.descendant) {
          kept.push(item)
          return
        }
        if (
          !present &&
          !(await lstat(workspace.source).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
            return undefined
          }))
        )
          return
        // Git already removed this worktree; what remains in its folder is not tracked by any checkout.
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
  async function land(id: ConversationId, context: Context, own = false): Promise<LandResult> {
    const record = await get(id, context)
    if (!record) throw new Error('Conversation has no workspace')
    return serial(record.source, async () => {
      const workspace = (await get(id, context))!
      const source = workspace.source
      await idle(id, context, own)
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
            // Binary files count `-` lines.
            const [added, removed, path] = line.split('\t')
            return { path, added: Number(added) || 0, removed: Number(removed) || 0 }
          })
        const needsRestart =
          (await realpath(source)) === (await realpath(host.ultimateRoot)) &&
          files.some(({ path }) => /^(server|shared)\//.test(path))
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
    const path = await landerPath(host.home, workspace.source)
    const { change } = await landerAgent(host, context)
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
      // Reads first: a transaction cannot read tables after its first write.
      const stopped = await landerIdle(tx, index, source)
      const lander = await ensureLander(tx, index, source, target, path)
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
      await configure(tx, lander, change)
      if (!queued) {
        await log(tx, lander, entry, { step: 'queued' })
        index.queue.push(entry)
      }
      if (stopped) await startLander(tx, index, source)
      const position = index.queue
        .filter((item) => item.source === source)
        .findIndex((item) => item.id === entry.id)
      return {
        id: entry.id,
        position: position + 1,
        lander,
        text: `Submitted ${tip.slice(0, 7)} as ${entry.id}, position ${position + 1} in the ${target} queue. The lander (conversation #${lander}) reports back here when it lands or fails; keep working.`,
      }
    }, context)
    host.harness().resume()
    return result
  }
  async function unavailable(id: ConversationId, context: Context) {
    let workspace = await get(id, context)
    if (!workspace) return undefined
    if (workspace.state === 'failed') {
      // Each tool call retries a failed setup, so a fixed environment (PATH, a lockfile) takes effect in place.
      const kept = await ready(id, context, true)
      if (kept) return `Workspace setup failed and its checkout keeps changes: ${kept.reason ?? ''}`
      workspace = (await get(id, context))!
      if (workspace.state === 'failed')
        return `Workspace setup failed: ${workspace.error}; fix the cause, then call a tool again to retry the setup`
    }
    if (workspace.state !== 'ready')
      return `Workspace is ${workspace.state}: ${workspace.error ?? 'checkout is not ready; send a new input to retry'}`
    if (!(await registeredCheckout(workspace)))
      return `Workspace checkout is missing or unregistered: ${workspace.path}${workspace.error ? `; ${workspace.error}` : ''}`
    return undefined
  }
  /**
   * Recreate a released checkout before the conversation uses it again, and with `retryFailed` also a failed setup whose
   * checkout the failure rolled back (a path still there, as a foreign folder, stays failed).
   */
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
      serial(record.source, async () => {
        if (parent && (await get(Number(parent) as ConversationId, context))?.state !== 'ready')
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
        const parentId = Number(parent) as ConversationId
        await ready(parentId, context)
        const source = (await get(parentId, context))!
        if (source.state === 'failed')
          throw new Error(`Source workspace #${parent} setup failed: ${source.error}`)
        retry = await serial(source.source, recreate)
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
    landerOwnsCheckout,
    started,
    get,
    unavailable,
    land,
    submit,
    pending,
    progress,
    release,
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
      await mkdir(join(host.home, 'worktrees'), { recursive: true })
      const parent = await realpath(join(host.home, 'worktrees'))
      index.items[String(id)] = {
        path: join(parent, String(id)),
        branch: `ultimate/${createHash('sha256').update(host.home).digest('hex').slice(0, 6)}-${id}`,
        base: await git(source, 'rev-parse', 'HEAD'),
        source,
        target,
        state: 'preparing',
      }
      await configure(tx, id, { cwd: index.items[String(id)].path })
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
      await idle(id, context)
      const workspace = await get(id, context)
      if (!workspace) throw new Error('Conversation has no workspace')
      if (workspace.state === 'preparing') throw new Error('Workspace is preparing')
      if (workspace.state !== 'removed') {
        if (await listedBySource(workspace)) await removeWorktree(workspace.source, workspace.path)
        await host.harness().commit(async (tx) => {
          ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)].state = 'removed'
        }, context)
      }
      return { text: `Discarded isolate; kept branch ${workspace.branch}.` }
    },
    /** Counts of the checkouts by state and by what their commits are, and the disk the worktrees directory takes. */
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
      await Promise.all(
        items.map(async (workspace) => {
          stats[workspace.state]++
          if (workspace.state !== 'ready') return
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
        }),
      )
      return stats
    },
    /**
     * The disk the worktrees directory takes: `bytes` counts every checkout's blocks, `real` counts blocks shared
     * between them once (btrfs only, null elsewhere). Measuring takes seconds, so one runs at a time and its result is
     * reused for a minute.
     */
    disk(): Promise<WorkspaceDisk> {
      if (disk.last && Date.now() - disk.last.at < 60_000) return Promise.resolve(disk.last)
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
            // Total, Exclusive, Set shared, Filename.
            const [, exclusive, shared] = stdout.trim().split('\n').at(-1)!.trim().split(/\s+/)
            return Number(exclusive) + Number(shared)
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
