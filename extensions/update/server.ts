import { readFile, stat, writeFile } from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord'
import { defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { EventToken } from '../../shared/events.ts'
import { implementAction } from '../../lib/actions.ts'
import { compareUrl } from '../../lib/compare.ts'
import { exec } from '../../lib/exec.ts'
import { fastForward, Refusal } from '../../lib/fast-forward.ts'
import type { Git } from '../../lib/fast-forward.ts'
import { githubRepo } from '../../lib/project-identity.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { SubagentsApi } from '../subagents/api.ts'
import { SubmissionLanded, WorkspacesApi } from '../workspaces/api.ts'
import type { LandedData } from '../workspaces/api.ts'
import { PauseApi } from '../pause/api.ts'
import {
  cloneState,
  fetchIfDue,
  gitPath,
  layersOf,
  SUMMARY_SYSTEM,
  summaryFor,
  withLock,
} from './clone.ts'
import { conflictsPredicted, mergeUpstream } from './merge.ts'
import type { Merged } from './merge.ts'
import { Applied, CheckAction, MergeAction, Refused, StateAction, UpdateAction } from './refs.ts'
import type { UpdateResult, UpdateState } from './refs.ts'
import { UpdateApi } from './api.ts'

/** How often the clone is compared with origin locally; origin itself is fetched at most hourly (`FETCH_EVERY`). */
export const TICK = 5 * 60_000

/** Git in `root`, never prompting: an HTTPS fetch without a login must fail rather than hang a background check. */
export const gitIn =
  (root: string): Git =>
  async (...args) => {
    try {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      return (await exec('git', args, { cwd: root, env, timeout: 120_000 })).stdout.trim()
    } catch (error) {
      const { stderr = '' } = error as { stderr?: string }
      throw new Error(`git ${args[0]} failed: ${stderr.trim() || String(error)}`, { cause: error })
    }
  }

const read = (path: string) =>
  readFile(path, 'utf8').catch(
    // A missing lockfile or install reads as absent: no clone of Ultimate lacks both.
    () => undefined,
  )

/** Whether `pnpm-lock.yaml` differs from what pnpm last installed (`node_modules/.pnpm/lock.yaml`). */
export async function installOwed(root: string) {
  const wanted = await read(join(root, 'pnpm-lock.yaml'))
  return wanted !== undefined && wanted !== (await read(join(root, 'node_modules/.pnpm/lock.yaml')))
}

/** Whether packages were installed after `startedAt` (ms): this server still runs the ones before. */
const installedSince = (root: string, startedAt: number) =>
  stat(join(root, 'node_modules/.pnpm/lock.yaml')).then(
    (info) => info.mtimeMs > startedAt,
    () => false,
  )

/**
 * Whether `server/` or `shared/` changed between `boot`, the commit this process started from, and the clone's HEAD:
 * the core still runs the old code, while extensions hot-reload against it.
 */
export async function coreChangedSince(git: Git, boot: string | undefined) {
  if (!boot) return false
  const files = await git('diff', '--name-only', boot, 'HEAD', '--', 'server', 'shared').catch(
    // An unknown boot commit or a broken clone: no evidence of a core change, so only installs ask for a restart.
    () => '',
  )
  return files !== ''
}

/** How long after an automatic restart no other one starts, across processes: a restart that does not help never loops. */
export const AUTO_RESTART_PAUSE = 10 * 60_000

/**
 * A listener for server facets that fail to load. When the running core is stale (`stale`: the core or packages changed
 * since boot), the facet most likely needs the new core, so it restarts the host at once, busy agents included: their
 * work resumes in the new process. A failure while the core is current is a real bug and stays a load error. Facets
 * failing in one reload join the first one's check, so they cause one restart; `last` (ms) keeps restarts apart.
 */
export function restartOnStaleLoad(options: {
  stale: () => Promise<boolean>
  restart: () => Promise<string>
  notice: (message: string) => void
  last: { read: () => Promise<number | undefined>; write: (at: number) => Promise<void> }
  pending: { current?: Promise<void> }
  now?: () => number
}) {
  const { stale, restart, notice, last, pending, now = Date.now } = options
  return (name: string) => {
    pending.current ??= (async () => {
      const at = await last.read()
      if (at !== undefined && now() - at < AUTO_RESTART_PAUSE) return
      if (!(await stale())) return
      await last.write(now())
      notice(`Restarting: ${name} failed to load after a core change`)
      notice(`Automatic restart failed: ${await restart()}`)
    })()
      .catch((error: unknown) => notice(`Automatic restart: ${String(error)}`))
      .finally(() => {
        pending.current = undefined
      })
  }
}

/**
 * Check failed facets again once packages are installed: one that failed before the install linked a landing's new
 * package found nothing stale then. `failed` names a facet that still has a load error.
 */
export async function retryStaleLoad(
  listener: (name: string) => void,
  pending: { current?: Promise<void> },
  failed: () => string | undefined,
) {
  await pending.current
  const name = failed()
  if (!name) return
  listener(name)
  await pending.current
}

/** Install the lockfile's packages when they differ from the installed ones; the install's last lines when it fails. */
async function installPackages(
  root: string,
): Promise<{ install: 'done' | 'failed' | 'skipped'; installError?: string }> {
  if (!(await installOwed(root))) return { install: 'skipped' }
  try {
    await exec('pnpm', ['install', '--frozen-lockfile'], { cwd: root, timeout: 10 * 60_000 })
    return { install: 'done' }
  } catch (error) {
    return { install: 'failed', installError: tail(error) }
  }
}

/**
 * Whether a landing calls for an install in the clone at `root`: its range changes `pnpm-lock.yaml` or `patches/`, and
 * the clone's checkout holds the landed commit (the lander fast-forwarded it, so it is the host's checkout).
 */
export async function landingInstalls(git: Git, { base, sha }: Pick<LandedData, 'base' | 'sha'>) {
  const files = await git('merge-base', '--is-ancestor', sha, 'HEAD').then(
    () => git('diff', '--name-only', base, sha),
    // Not an ancestor, or unknown here: the landing went into another repository or branch.
    () => '',
  )
  return files.split('\n').some((file) => file === 'pnpm-lock.yaml' || file.startsWith('patches/'))
}

/** The last output lines of a failed command. */
function tail(error: unknown) {
  const { stdout = '', stderr = '' } = error as {
    stdout?: string
    stderr?: string
  }
  const output = `${stdout}${stderr}`.trim()
  return output ? output.split('\n').slice(-20).join('\n') : String(error)
}

/** A preview started by another Ultimate's `instance` tool: it shares the clone and must never touch it. */
const preview = () => Boolean(process.env.ULTIMATE_INSTANCE_OWNER)

const previewState = (root: string): UpdateState => ({
  root,
  behind: 0,
  commits: [],
  install: false,
  restart: false,
  preview: true,
})

export default function update(host: ExtensionHost) {
  // Resolved where they are called; declared here so the catalogue lists them.
  host.need(WorkspacesApi)
  host.need(ConversationsApi)
  host.need(SubagentsApi)
  host.want(PauseApi)
  host.implement(UpdateApi, { state: () => currentState(host) })
  const shared = state(host)
  // Read HEAD at load, before any landing or update can move it.
  boot(host)
  // A preview never fetches: it must not race the host on the same clone.
  if (preview()) return defineExtension({ name: 'update' })
  const lastFile = join(host.home, 'update-auto-restart.json')
  const pending = host.resource<{ current?: Promise<void> }>('update.auto-restart', () => ({}))
  const onLoadError = restartOnStaleLoad({
    stale: async () =>
      (await installedSince(host.ultimateRoot, Date.parse(host.system().process.startedAt))) ||
      (await coreChangedSince(gitIn(host.ultimateRoot), await boot(host).head)),
    // A successful restart never returns: this process is released and the new core resumes its work.
    restart: () => host.restart(async () => {}),
    notice: (message) => host.notice(message),
    last: {
      read: () =>
        readFile(lastFile, 'utf8').then(
          (text) => (JSON.parse(text) as { at: number }).at,
          // No automatic restart recorded yet.
          () => undefined,
        ),
      write: (at) => writeFile(lastFile, JSON.stringify({ at })),
    },
    pending,
  })
  host.onLoadError(onLoadError)
  const tick = () => {
    // Paused: no fetch starts until Play; the next tick after it catches up.
    if (host.want(PauseApi)?.paused()) return
    shared.ticking ??= refresh(host, true)
      .catch((error: unknown) => host.notice(`Update check: ${String(error)}`))
      .finally(() => {
        shared.ticking = undefined
      })
  }
  // A landing into the host's checkout that changes packages installs them at once; the status line then asks for the
  // restart, or shows the install as owed when it failed. Not awaited: the reactor's transaction stays short.
  host.react(
    'install-landed',
    [SubmissionLanded],
    async (_tx, { data }) => {
      const root = host.ultimateRoot
      if (!(await landingInstalls(gitIn(root), data))) return
      shared.installing ??= withLock(await lockOf(root), () => installPackages(root))
        .then(() =>
          retryStaleLoad(
            onLoadError,
            pending,
            () => host.extensions().find((extension) => extension.server?.error)?.name,
          ),
        )
        .then(() => refresh(host, false))
        .catch((error: unknown) => host.notice(`Install after landing: ${String(error)}`))
        .finally(() => {
          shared.installing = undefined
        })
    },
    { from: 'now' },
  )
  const start = setTimeout(tick, 30_000)
  const timer = setInterval(tick, TICK)
  host.onClose(async () => {
    clearTimeout(start)
    clearInterval(timer)
    await shared.ticking
    await shared.installing
  })
  return defineExtension({ name: 'update' })
}

type Shared = {
  ticking: Promise<void> | undefined
  checking: Promise<void> | undefined
  updating: Promise<UpdateResult> | undefined
  installing: Promise<void> | undefined
  latest: UpdateState | undefined
  updated: (UpdateResult & { ok: true }) | undefined
}

/** Shared across reloads: a reload installs the new facet before the old one closes, and only one tick may run. */
const state = (host: ExtensionHost) =>
  host.resource<Shared>('update.state', () => ({
    ticking: undefined,
    checking: undefined,
    updating: undefined,
    installing: undefined,
    latest: undefined,
    updated: undefined,
  }))

/**
 * The clone's HEAD when this process first loaded the extension, read once: a resource outlives reloads, not the
 * process. Undefined when git fails (see `coreChangedSince`).
 */
const boot = (host: ExtensionHost) =>
  host.resource('update.boot-head', () => ({
    head: gitIn(host.ultimateRoot)('rev-parse', 'HEAD').catch(
      // Not a git checkout or git missing: restarts are then asked for installs only.
      () => undefined,
    ),
  }))

/** The clone-wide lock: fetches, updates and installs of one clone never overlap across the Ultimates on it. */
const lockOf = (root: string) => gitPath(gitIn(root), root, 'ultimate-update.lock')

/** Ask the summary model once with the range's commit messages; undefined without one. */
async function ask(host: ExtensionHost, input: string) {
  const conversations = host.need(ConversationsApi)
  const model = await conversations.summaryModel()
  if (!model) return undefined
  const response = await conversations.askSummaryModel(
    host.modelRuntime,
    SUMMARY_SYSTEM,
    input,
    AbortSignal.timeout(60_000),
    { model },
  )
  return response.stopReason === 'stop' ? response.text : undefined
}

/**
 * Compare the clone with origin and keep the result for `state`. A `check` fetches when due and summarizes a new
 * range (once per range, cached in the clone's git directory); `force` fetches even when not due; a plain refresh
 * only reads.
 */
async function refresh(host: ExtensionHost, check: boolean, force = false) {
  const shared = state(host)
  const root = host.ultimateRoot
  const git = gitIn(root)
  const summaryFile = await gitPath(git, root, 'ultimate-update-summary.json')
  /** The summary of the clone's current range; asks the model only with `asking`, else reads the cache. */
  const summarize = async (asking: boolean) => {
    const { head, remoteHead } = await cloneState(git, root)
    if (!remoteHead) return undefined
    return summaryFor(
      summaryFile,
      `${head}..${remoteHead}`,
      () => git('log', '--format=%s%n%n%b', `${head}..${remoteHead}`),
      asking ? (input) => ask(host, input) : undefined,
    )
  }
  // Under the clone's lock the fetch's age and the summary cache are read again, so the Ultimates on one clone fetch
  // and ask the summary model once between them.
  const checked = check
    ? await withLock(await lockOf(root), async () => {
        const error = await fetchIfDue(git, root, Date.now(), force)
        await summarize(true)
        return { error }
      })
    : undefined
  const error = checked ? checked.error : shared.latest?.error
  const clone = await cloneState(git, root)
  const repo = clone.remoteHead ? await githubRepo(root) : undefined
  const startedAt = Date.parse(host.system().process.startedAt)
  const { head, remoteHead, ...rest } = clone
  const summary = await summarize(false)
  // Checked for a diverged clone too: a merge must not be offered while the lander moves the same branch.
  const landingNow = rest.behind ? await landing(host) : undefined
  shared.latest = {
    root,
    head,
    ...rest,
    ...(summary ? { summary } : {}),
    refused: rest.refused ?? landingNow,
    ...(rest.diverged && !landingNow && (await isProject(host)) ? { merge: true as const } : {}),
    ...(error ? { error } : {}),
    ...(repo && remoteHead ? { compare: compareUrl(repo, head, remoteHead) } : {}),
    install: await installOwed(root),
    restart:
      (await installedSince(root, startedAt)) ||
      (await coreChangedSince(git, await boot(host).head)),
    ...(shared.updated ? { updated: shared.updated } : {}),
  }
  if (!shared.latest.refused) delete shared.latest.refused
}

/** The clone's update state from the last check, read locally once when none was made yet; never fetches. */
async function currentState(host: ExtensionHost) {
  const shared = state(host)
  if (preview()) return previewState(host.ultimateRoot)
  if (!shared.latest) await refresh(host, false)
  return shared.latest!
}

/**
 * Whether the clone is the project this Ultimate serves. Only then can a branch merge origin into it: the lander lands
 * a branch into the project's checkout, never into a separate clone Ultimate runs from.
 */
const isProject = async (host: ExtensionHost) =>
  (await realpath(host.ultimateRoot)) === (await realpath(host.projectRoot))

/** What @ultimate reads when the user asks it to merge origin into the diverged clone. */
const mergeInput = (branch: string, root: string, ahead: number, behind: number) =>
  [
    `Update with @ultimate: ${branch} in ${root} has diverged from origin/${branch} (${ahead} local ${ahead === 1 ? 'commit' : 'commits'}, ${behind} new upstream), so Update now can't fast-forward it.`,
    `Start a coordinator branch that merges origin/${branch} into ${branch} in its worktree: git fetch origin, then a normal git merge origin/${branch}, never a rebase, reset or force push.`,
    'It resolves the conflicts it can resolve safely, sends the unclear ones back as decisions, runs the checks and the tests covering the conflicts, and lands the merge with workspace submit.',
    'Afterwards the update item asks for any restart the upstream changes need.',
  ].join('\n')

/** What @ultimate reads when a merged update's `pnpm check` failed and the user asks it to fix that. */
const fixInput = (root: string, branch: string, to: string, checkError?: string) =>
  [
    `Update with @ultimate: the update merged origin into ${branch} in ${root} (now at ${to}), but pnpm check fails${checkError ? `:\n${checkError}` : '.'}`,
    'Start a coordinator branch that fixes the failing check on the merged result: it reads the failure, fixes it at its cause, runs pnpm check and the tests covering what it changed, and lands with workspace submit.',
  ].join('\n')

/** Why an update must wait: the lander is landing into the clone (it fast-forwards the same branch). */
async function landing(host: ExtensionHost) {
  let index
  try {
    index = await host
      .harness()
      .snapshot(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID, context)
  } catch {
    // Storage is closed (a core swap): nothing lands from this home meanwhile.
    return undefined
  }
  const root = await realpath(host.ultimateRoot)
  return index?.queue.some((entry) => entry.source === root && entry.state === 'landing')
    ? 'The lander is landing into this clone'
    : undefined
}

/** Commit one update event on its own: the clone lives outside storage. Only while storage is open. */
async function record<D extends JsonValue>(host: ExtensionHost, event: EventToken<D>, data: D) {
  try {
    await host.harness().commit((tx) => host.emit(tx, event, data), context)
  } catch (error) {
    // Storage is closed (a core swap) or the commit failed: the update itself stands, only its record is lost.
    host.notice(`Update event: ${String(error)}`)
  }
}

/**
 * `pnpm check` on a merged clone, so a broken merge is caught before the user is told it's done. A failed check
 * keeps the merge — nothing resets by itself — with its last output lines; the state offers the undo command.
 */
async function checkAfterMerge(
  root: string,
): Promise<{ check: 'passed' | 'failed'; checkError?: string }> {
  try {
    await exec('pnpm', ['check'], { cwd: root, timeout: 10 * 60_000 })
    return { check: 'passed' }
  } catch (error) {
    return { check: 'failed', checkError: tail(error) }
  }
}

/**
 * Fast-forward the clone — a diverged branch merges with origin instead, predicting conflicts first and
 * restoring itself on one — install when the lockfile is owed (also with nothing to pull, so a failed install is
 * retried), check a merge, and record what happened. Holds the clone-wide lock throughout.
 */
async function run(host: ExtensionHost): Promise<UpdateResult> {
  const root = host.ultimateRoot
  const refuse = async (refused: string): Promise<UpdateResult> => {
    await record(host, Refused, { root, reason: refused })
    return { ok: false, refused }
  }
  const result = await withLock(await lockOf(root), () => apply(host, refuse))
  return result ?? refuse('Another Ultimate is updating this clone')
}

async function apply(
  host: ExtensionHost,
  refuse: (refused: string) => Promise<UpdateResult>,
): Promise<UpdateResult> {
  const root = host.ultimateRoot
  const git = gitIn(root)
  let merged: Merged | undefined
  let moved
  try {
    // The landing check runs again right before either move, after the fetch. A landing that starts after it is
    // safe: the lander fast-forwards only from the base it merged onto, sees the moved branch and retries.
    moved = await fastForward(
      git,
      undefined,
      () => landing(host),
      async (standing) => {
        const refused = await landing(host)
        if (refused) throw new Refusal(refused)
        merged = await mergeUpstream(git, await conflictsPredicted(root, standing.remote), standing)
        return merged
      },
    )
  } catch (error) {
    if (error instanceof Refusal) return refuse(error.message)
    throw error
  }
  const files =
    moved.before === moved.after ? '' : await git('diff', '--name-only', moved.before, moved.after)
  const layers = layersOf(files.split('\n').filter(Boolean))
  // Owed while the lockfile differs from the installed one: a failed install is retried by the next update.
  const { install, installError } = await installPackages(root)
  const checked = merged ? await checkAfterMerge(root) : undefined
  const result = {
    ok: true as const,
    from: moved.before.slice(0, 7),
    to: moved.after.slice(0, 7),
    commits: moved.behind,
    layers,
    install,
    ...(merged && checked
      ? { merged: true as const, restore: merged.restore, check: checked.check }
      : {}),
    ...(checked?.checkError ? { checkError: checked.checkError } : {}),
    ...(merged && checked?.check === 'failed' && (await isProject(host))
      ? { fixable: true as const }
      : {}),
    ...(installError ? { installError } : {}),
  }
  if (moved.behind || install !== 'skipped') state(host).updated = result
  if (moved.behind) {
    await record(host, Applied, {
      root,
      from: moved.before,
      to: moved.after,
      commits: moved.behind,
      layers,
      install,
      ...(merged && checked
        ? { merged: true as const, restore: merged.restore, check: checked.check }
        : {}),
    })
  }
  return result
}

export const userActions = ['merge']

export const actions = {
  /** The clone's update state from the last check. */
  state: implementAction(StateAction, (_args, { host }) => currentState(host)),
  check: implementAction(CheckAction, async (_args, { host }) => {
    const shared = state(host)
    if (preview()) return previewState(host.ultimateRoot)
    // A background tick may be mid-check without forcing: let it finish, then fetch now. A second click joins.
    await shared.ticking
    shared.checking ??= refresh(host, true, true).finally(() => {
      shared.checking = undefined
    })
    await shared.checking
    return shared.latest!
  }),
  update: implementAction(UpdateAction, async (_args, { host }): Promise<UpdateResult> => {
    const shared = state(host)
    if (preview()) return { ok: false, refused: 'A preview never updates the clone it runs from' }
    // One update at a time: a second click joins the first.
    shared.updating ??= run(host).finally(() => {
      shared.updating = undefined
    })
    const result = await shared.updating
    await refresh(host, false)
    return result
  }),
  merge: implementAction(MergeAction, async (_args, { host }) => {
    if (preview()) throw new Error('A preview never updates the clone it runs from')
    await refresh(host, false)
    const latest = state(host).latest!
    // Either a diverged clone to merge through a branch (predicted conflicts), or a merged update whose
    // check failed, to fix where it landed.
    const failed = latest.updated?.check === 'failed' ? latest.updated : undefined
    if (!latest.merge && !failed?.fixable)
      throw new Error(latest.refused ?? `${latest.branch} has not diverged`)
    const { head, remoteHead } = await cloneState(gitIn(host.ultimateRoot), host.ultimateRoot)
    const id = await host.need(SubagentsApi).standing('ultimate', context)
    const conversation = (await host.harness().conversation(id, context))!
    await conversation.submit(
      {
        type: 'input',
        content: failed?.fixable
          ? fixInput(latest.root, latest.branch ?? 'main', failed.to, failed.checkError)
          : mergeInput(latest.branch!, latest.root, latest.ahead ?? 0, latest.behind),
        // One ask per range, or per merged commit: a second click while @ultimate is on it adds nothing.
        requestId: failed ? `update-fix:${failed.to}` : `update-merge:${head}..${remoteHead}`,
        whenBusy: 'followUp',
      },
      context,
    )
    return { id }
  }),
}
