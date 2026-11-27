import { existsSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import { defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { EventToken } from '../../shared/events.ts'
import { implementAction } from '../../lib/actions.ts'
import { rebuiltOnOpen, ignoring, isMissing, meansNone, settled } from '../../lib/errors.shared.ts'
import { deadline, every, pace } from '../../lib/timers.shared.ts'
import { compareUrl } from '../../lib/compare.shared.ts'
import { exec } from '../../lib/exec.ts'
import { fastForward, Refusal } from '../../lib/fast-forward.ts'
import type { Git } from '../../lib/fast-forward.ts'
import { githubRepo } from '../../lib/project-identity.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { SubagentsApi } from '../subagents/api.ts'
import { SubmissionLanded, WorkspacesApi } from '../workspaces/api.ts'
import { PauseApi } from '../pause/api.ts'
import {
  cloneState,
  updateMessages,
  fetchIfDue,
  gitPath,
  layersOf,
  SUMMARY_SYSTEM,
  summaryFor,
  withLock,
} from './clone.ts'
import { Applied, CheckAction, MergeAction, Refused, StateAction, UpdateAction } from './refs.ts'
import type { UpdateResult, UpdateState } from './refs.ts'
import { UpdateApi } from './api.ts'

export const TICK = 5 * 60_000

export const gitIn =
  (root: string): Git =>
  async (...args) => {
    try {
      const nonInteractiveGitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      return (
        await exec('git', args, { cwd: root, env: nonInteractiveGitEnv, timeout: 120_000 })
      ).stdout.trim()
    } catch (error) {
      const { stderr = '' } = error as { stderr?: string }
      throw new Error(`git ${args[0]} failed: ${stderr.trim() || String(error)}`, { cause: error })
    }
  }

const read = (path: string) => readFile(path, 'utf8').catch(ignoring(isMissing))

export async function installOwed(root: string) {
  const wanted = await read(join(root, 'pnpm-lock.yaml'))
  return wanted !== undefined && wanted !== (await read(join(root, 'node_modules/.pnpm/lock.yaml')))
}

const installedSince = (root: string, processStartedAtMs: number) =>
  stat(join(root, 'node_modules/.pnpm/lock.yaml')).then(
    (info) => info.mtimeMs > processStartedAtMs,
    () => false,
  )

async function restartAfterCoreLanding(
  host: Pick<ExtensionHost, 'restart' | 'notice'>,
  stale: () => Promise<boolean>,
) {
  if (!(await stale())) return
  host.notice('Restarting: a landing changed the core')
  host.notice(`Restart after landing failed: ${await host.restart(async () => {})}`)
}

export const AUTO_RESTART_PAUSE = 10 * 60_000

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
      const restartCooldownActive = at !== undefined && now() - at < AUTO_RESTART_PAUSE
      if (restartCooldownActive) return
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

async function installPackages(
  host: ExtensionHost,
): Promise<{ install: 'done' | 'failed' | 'skipped'; installError?: string }> {
  const shared = reloadSharedState(host)
  const root = host.ultimateRoot
  if (!shared.failed && !(await installOwed(root))) return { install: 'skipped' }
  const lockfile = await read(join(root, 'pnpm-lock.yaml'))
  try {
    await exec('pnpm', ['install', '--frozen-lockfile'], { cwd: root, timeout: 10 * 60_000 })
  } catch (error) {
    const installError = tail(error)
    shared.failed = { lockfile, error: installError }
    return { install: 'failed', installError }
  }
  shared.failed = undefined
  const broken = host.extensions().find((extension) => extension.server?.error)?.name
  const scheduleRecoveryAfterInstall = shared.recover
  if (broken) scheduleRecoveryAfterInstall?.(broken)
  return { install: 'done' }
}

const checkoutWriteWaitMs = 60_000
const cloneInstallWaitMs = 10 * 60_000

export function loadable(host: ExtensionHost): Promise<void> {
  const shared = reloadSharedState(host)
  const root = host.ultimateRoot
  shared.installing ??= (async () => {
    const checkoutWriteLock = await gitPath(gitIn(root), root, 'index.lock').catch(meansNone)
    const checkoutWriteDeadlineMs = Date.now() + checkoutWriteWaitMs
    if (checkoutWriteLock)
      while (existsSync(checkoutWriteLock) && Date.now() < checkoutWriteDeadlineMs) await pace(50)
    const failure = (error: string) =>
      new Error(`pnpm install failed, so the packages on disk are not the lockfile's:\n${error}`)
    const failedInstall = shared.failed
    const sameLockfileAlreadyFailed =
      failedInstall && failedInstall.lockfile === (await read(join(root, 'pnpm-lock.yaml')))
    if (sameLockfileAlreadyFailed) throw failure(failedInstall.error)
    if (!failedInstall && !(await installOwed(root))) return
    const result = await withLock(
      await cloneWideUpdateLock(root),
      () => installPackages(host),
      cloneInstallWaitMs,
    )
    await refresh(host, false).catch((error: unknown) =>
      host.notice(`Update check: ${String(error)}`),
    )
    if (!result) throw new Error('Another Ultimate is still installing packages into this clone')
    if (result.install === 'failed') throw failure(result.installError!)
  })().finally(() => {
    shared.installing = undefined
  })
  return shared.installing
}

function tail(error: unknown) {
  const { stdout = '', stderr = '' } = error as {
    stdout?: string
    stderr?: string
  }
  const output = `${stdout}${stderr}`.trim()
  return output ? output.split('\n').slice(-20).join('\n') : String(error)
}

const sharesHostCloneAsPreview = () => Boolean(process.env.ULTIMATE_INSTANCE_OWNER)

const previewState = (root: string): UpdateState => ({
  root,
  behind: 0,
  commits: [],
  install: false,
  restart: false,
  preview: true,
})

export default function update(host: ExtensionHost) {
  host.need(WorkspacesApi)
  host.need(ConversationsApi)
  host.need(SubagentsApi)
  host.want(PauseApi)
  host.implement(UpdateApi, { state: () => locallyRefreshedState(host) })
  const shared = reloadSharedState(host)
  if (sharesHostCloneAsPreview()) return defineExtension({ name: 'update' })
  const lastFile = join(host.home, 'update-auto-restart.json')
  const pending = host.resource<{ current?: Promise<void> }>('update.auto-restart', () => ({}))
  const stale = async () =>
    host.coreChanged() ||
    (await installedSince(host.ultimateRoot, Date.parse(host.system().process.startedAt)))
  const onLoadError = restartOnStaleLoad({
    stale,
    restart: () => host.restart(async () => {}),
    notice: (message) => host.notice(message),
    last: {
      read: () =>
        readFile(lastFile, 'utf8').then(
          (text) => (JSON.parse(text) as { at: number }).at,
          () => undefined,
        ),
      write: (at) => writeFile(lastFile, JSON.stringify({ at })),
    },
    pending,
  })
  host.onLoadError(onLoadError)
  shared.recover = onLoadError
  host.onBeforeLoad(() => loadable(host))
  const tick = () => {
    if (host.want(PauseApi)?.paused()) return
    shared.ticking ??= refresh(host, true)
      .catch((error: unknown) => host.notice(`Update check: ${String(error)}`))
      .finally(() => {
        shared.ticking = undefined
      })
  }
  host.react(
    'install-landed',
    [SubmissionLanded],
    async () => {
      rebuiltOnOpen(
        'onBeforeLoad installs an owed lockfile again, and a new core boots on the landed code',
        loadable(host)
          .then(() => restartAfterCoreLanding(host, stale))
          .catch((error: unknown) => host.notice(`After landing: ${String(error)}`)),
      )
    },
    { from: 'now' },
  )
  const cancelStart = deadline(30_000, tick)
  const stopTicking = every(TICK, tick)
  host.onClose(async () => {
    cancelStart()
    stopTicking()
    await shared.ticking
    if (shared.installing) await settled(shared.installing)
  })
  return defineExtension({ name: 'update' })
}

type Shared = {
  ticking: Promise<void> | undefined
  checking: Promise<void> | undefined
  updating: Promise<UpdateResult> | undefined
  installing: Promise<void> | undefined
  failed: { lockfile: string | undefined; error: string } | undefined
  recover: ((name: string) => void) | undefined
  latest: UpdateState | undefined
  updated: (UpdateResult & { ok: true }) | undefined
}

const reloadSharedState = (host: ExtensionHost) =>
  host.resource<Shared>('update.state', () => ({
    ticking: undefined,
    checking: undefined,
    updating: undefined,
    installing: undefined,
    failed: undefined,
    recover: undefined,
    latest: undefined,
    updated: undefined,
  }))

const cloneWideUpdateLock = (root: string) => gitPath(gitIn(root), root, 'ultimate-update.lock')

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

async function refresh(host: ExtensionHost, fetchAndSummarizeUnderLock: boolean, force = false) {
  const shared = reloadSharedState(host)
  const root = host.ultimateRoot
  const git = gitIn(root)
  const summaryFile = await gitPath(git, root, 'ultimate-update-summary.json')
  const summarize = async (allowModelRequest: boolean) => {
    const { head, remoteHead } = await cloneState(git, root)
    if (!remoteHead) return undefined
    return summaryFor(
      summaryFile,
      `${head}..${remoteHead}`,
      () => updateMessages(git, `${head}..${remoteHead}`),
      allowModelRequest ? (input) => ask(host, input) : undefined,
    )
  }
  const checked = fetchAndSummarizeUnderLock
    ? await withLock(await cloneWideUpdateLock(root), async () => {
        const error = await fetchIfDue(git, root, Date.now(), force)
        await summarize(true)
        return { error }
      })
    : undefined
  const error = checked ? checked.error : shared.latest?.error
  const clone = await cloneState(git, root)
  const repo = clone.remoteHead ? await githubRepo(root) : undefined
  const startedAt = Date.parse(host.system().process.startedAt)
  const { head, remoteHead, diverged, ...rest } = clone
  const summary = await summarize(false)
  const landingNow = rest.behind ? await landingRefusalOrClosedStorage(host) : undefined
  shared.latest = {
    root,
    head,
    ...rest,
    ...(summary ? { summary } : {}),
    refused: rest.refused ?? landingNow,
    ...(diverged && !landingNow && (await landerCanReachClone(host))
      ? { merge: true as const }
      : {}),
    ...(error ? { error } : {}),
    ...(repo && remoteHead ? { compare: compareUrl(repo, head, remoteHead) } : {}),
    install: !!shared.failed || (await installOwed(root)),
    restart: host.coreChanged() || (await installedSince(root, startedAt)),
    ...(shared.updated ? { updated: shared.updated } : {}),
  }
  if (!shared.latest.refused) delete shared.latest.refused
}

async function locallyRefreshedState(host: ExtensionHost) {
  const shared = reloadSharedState(host)
  if (sharesHostCloneAsPreview()) return previewState(host.ultimateRoot)
  if (!shared.latest) await refresh(host, false)
  return shared.latest!
}

const landerCanReachClone = async (host: ExtensionHost) =>
  (await realpath(host.ultimateRoot)) === (await realpath(host.projectRoot))

const mergeInput = (branch: string, root: string, ahead: number, behind: number) =>
  [
    `Update with @ultimate: ${branch} in ${root} has diverged from origin/${branch} (${ahead} local ${ahead === 1 ? 'commit' : 'commits'}, ${behind} new upstream), so Update now can't fast-forward it.`,
    `Start a coordinator branch that merges origin/${branch} into ${branch} in its worktree: git fetch origin, then a normal git merge origin/${branch}, never a rebase, reset or force push.`,
    'It resolves the conflicts it can resolve safely, sends the unclear ones back as decisions, runs the checks and the tests covering the conflicts, and lands the merge with workspace submit.',
    'Afterwards the update item asks for any restart the upstream changes need.',
  ].join('\n')

async function landingRefusalOrClosedStorage(host: ExtensionHost) {
  let index
  try {
    index = await host
      .harness()
      .snapshot(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID, context)
  } catch {
    return undefined
  }
  const root = await realpath(host.ultimateRoot)
  return index?.queue.some((entry) => entry.source === root && entry.state === 'landing')
    ? 'The lander is landing into this clone'
    : undefined
}

async function recordWithoutRollingBackClone<D extends JsonValue>(
  host: ExtensionHost,
  event: EventToken<D>,
  data: D,
) {
  try {
    await host.harness().commit((tx) => host.emit(tx, event, data), context)
  } catch (error) {
    host.notice(`Update event: ${String(error)}`)
  }
}

async function run(host: ExtensionHost): Promise<UpdateResult> {
  const root = host.ultimateRoot
  const refuse = async (refused: string): Promise<UpdateResult> => {
    await recordWithoutRollingBackClone(host, Refused, { root, reason: refused })
    return { ok: false, refused }
  }
  const result = await withLock(await cloneWideUpdateLock(root), () => apply(host, refuse))
  return result ?? refuse('Another Ultimate is updating this clone')
}

async function apply(
  host: ExtensionHost,
  refuse: (refused: string) => Promise<UpdateResult>,
): Promise<UpdateResult> {
  const root = host.ultimateRoot
  const git = gitIn(root)
  let moved
  try {
    const recheckLandingAfterFetch = () => landingRefusalOrClosedStorage(host)
    moved = await fastForward(git, undefined, recheckLandingAfterFetch)
  } catch (error) {
    if (error instanceof Refusal) return refuse(error.message)
    throw error
  }
  const files =
    moved.before === moved.after ? '' : await git('diff', '--name-only', moved.before, moved.after)
  const layers = layersOf(files.split('\n').filter(Boolean))
  const { install, installError } = await installPackages(host)
  const result = {
    ok: true as const,
    from: moved.before.slice(0, 7),
    to: moved.after.slice(0, 7),
    commits: moved.behind,
    layers,
    install,
    ...(installError ? { installError } : {}),
  }
  if (moved.behind || install !== 'skipped') reloadSharedState(host).updated = result
  if (moved.behind) {
    await recordWithoutRollingBackClone(host, Applied, {
      root,
      from: moved.before,
      to: moved.after,
      commits: moved.behind,
      layers,
      install,
    })
  }
  return result
}

const mergeRequestIdForRange = (head: string, remoteHead: string | undefined) =>
  `update-merge:${head}..${remoteHead}`

export const userActions = ['merge']

export const actions = {
  state: implementAction(StateAction, (_args, { host }) => locallyRefreshedState(host)),
  check: implementAction(CheckAction, async (_args, { host }) => {
    const shared = reloadSharedState(host)
    if (sharesHostCloneAsPreview()) return previewState(host.ultimateRoot)
    const backgroundCheckBeforeForcedFetch = shared.ticking
    await backgroundCheckBeforeForcedFetch
    shared.checking ??= refresh(host, true, true).finally(() => {
      shared.checking = undefined
    })
    await shared.checking
    return shared.latest!
  }),
  update: implementAction(UpdateAction, async (_args, { host }): Promise<UpdateResult> => {
    const shared = reloadSharedState(host)
    if (sharesHostCloneAsPreview())
      return { ok: false, refused: 'A preview never updates the clone it runs from' }
    shared.updating ??= run(host).finally(() => {
      shared.updating = undefined
    })
    const result = await shared.updating
    await refresh(host, false)
    return result
  }),
  merge: implementAction(MergeAction, async (_args, { host }) => {
    if (sharesHostCloneAsPreview())
      throw new Error('A preview never updates the clone it runs from')
    await refresh(host, false)
    const latest = reloadSharedState(host).latest!
    if (!latest.merge) throw new Error(latest.refused ?? `${latest.branch} has not diverged`)
    const { head, remoteHead } = await cloneState(gitIn(host.ultimateRoot), host.ultimateRoot)
    const id = await host.need(SubagentsApi).standing('ultimate', context)
    const conversation = (await host.harness().conversation(id, context))!
    await conversation.submit(
      {
        type: 'input',
        content: mergeInput(latest.branch!, latest.root, latest.ahead ?? 0, latest.behind),
        requestId: mergeRequestIdForRange(head, remoteHead),
        whenBusy: 'followUp',
      },
      context,
    )
    return { id }
  }),
}
