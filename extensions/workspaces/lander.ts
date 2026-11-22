import type {
  ConversationId,
  JsonObject,
  ConversationDocToken,
  Tx,
} from '@earendil-works/pi-durable'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { copyJson } from '@earendil-works/chord/json'
import type { Context } from '@earendil-works/chord/context'
import { withAbortSignal } from '@earendil-works/chord/context'
import { defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { debounce, deadline } from '../../lib/timers.ts'
import { git } from '../../lib/git.ts'
import { overshadowed, retriedLater, settled } from '../../lib/errors.ts'
import { needsRestart as restartNeeded } from '../../lib/layers.ts'
import { formatDuration } from '../../lib/format.ts'
import { runGroup, sweepPidFiles } from '../../lib/process-group.ts'
import { landingWeight } from '../../lib/token-weight.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { CheckRan, SubmissionFailed, SubmissionLanded } from './api.ts'
import { setup } from './setup.ts'
import { addCheckout, treePath } from './tree.ts'
import type { Landed, LanderEntry, LanderOutcome, QueueEntry, WorkspaceIndex } from './types.ts'
import { LanderLog } from './entries.ts'
import { LanderReportEntry } from './refs.ts'

const recentSubmitCardOutcomeLimit = 50
export async function landerPath(home: string, source: string, settings: JsonObject) {
  const configured = await treePath(settings, landerName(source))
  if (configured) return configured
  await mkdir(join(home, 'lander'), { recursive: true })
  return join(await realpath(join(home, 'lander')), landerHash(source))
}
const landerHash = (source: string) =>
  createHash('sha256').update(source).digest('hex').slice(0, 12)
const landerName = (source: string) => `ult-lander-${landerHash(source)}`
const checkoutCreationQueues = new Map<string, Promise<string>>()
export async function landerCheckout(
  home: string,
  source: string,
  settings: JsonObject,
  tip = 'HEAD',
) {
  const path = await landerPath(home, source, settings)
  const queued = settled(checkoutCreationQueues.get(path) ?? Promise.resolve()).then(async () => {
    const registered = (await git(source, 'worktree', 'list', '--porcelain'))
      .split('\n\n')
      .some((entry) => entry.split('\n').includes(`worktree ${path}`))
    if (!registered) {
      await rm(path, { recursive: true, force: true })
      await git(source, 'worktree', 'prune')
      await addCheckout(settings, source, path, landerName(source), ['--detach', tip])
    }
    return path
  })
  checkoutCreationQueues.set(path, queued)
  try {
    return await queued
  } finally {
    if (checkoutCreationQueues.get(path) === queued) checkoutCreationQueues.delete(path)
  }
}
export const log = (
  tx: Tx,
  id: ConversationId,
  entry: Pick<
    QueueEntry,
    'id' | 'conversationId' | 'tip' | 'target' | 'at' | 'divergence' | 'subject' | 'steps'
  >,
  data: Omit<LanderEntry, 'submission' | 'conversationId' | 'tip' | 'target' | 'at'>,
) => {
  const at = Date.now()
  if (data.step)
    entry.steps.push({
      step: data.step,
      at,
      ...(data.runs ? { runs: data.runs } : {}),
      ...(data.check ? { check: data.check } : {}),
    })
  return tx.appendEntry(LanderLog, id, {
    data: {
      submission: entry.id,
      conversationId: entry.conversationId,
      tip: entry.tip,
      target: entry.target,
      at,
      sourceEntry: entry.at,
      divergence: entry.divergence,
      ...(entry.subject && (data.step === 'queued' || data.step === 'started' || data.outcome)
        ? { subject: entry.subject }
        : {}),
      ...data,
    },
  })
}
const starterLine = (
  branch: ConversationId,
  sha: string,
  outcome: WorkspaceIndex['results'][string],
) =>
  [
    `#${branch}${outcome.subject?.title ? ` ${outcome.subject.title}` : ''} ${outcome.commits?.length ? `landed as ${sha.slice(0, 7)} on ${outcome.target}` : `had nothing new to land on ${outcome.target}`}`,
    ...(outcome.pushed ? [`pushed`] : []),
    ...(outcome.reason ? [outcome.reason] : []),
    ...(outcome.needsRestart ? ['needs restart'] : []),
    ...(outcome.flaky?.length ? [`flaky: ${outcome.flaky.join(', ')}`] : []),
  ]
    .join(' · ')
    .replace(/\s*\n\s*/g, ' ')

type Host = Pick<
  ExtensionHost,
  'home' | 'ultimateRoot' | 'harness' | 'projectSettings' | 'doc' | 'metadata' | 'notice' | 'emit'
>
type Seconds = number
type Check = { command: string; timeout?: Seconds }
type ConcurrentCheckGroup = Check[]
type Settings = {
  checks: (Check | ConcurrentCheckGroup)[]
  push?: string
}
const maxTargetMoveAttempts = 3
type CheckLimits = { stall: Seconds; total: Seconds }
const defaultCheckLimitsSeconds: CheckLimits = { stall: 2 * 60, total: 10 * 60 }
export const limitsFor = (check: Check, limits: CheckLimits): CheckLimits =>
  check.timeout === undefined
    ? limits
    : { stall: Math.min(limits.stall, check.timeout), total: check.timeout }
const vitestFailureLine = /^\s*(FAIL|×|✗)\s/

export const checkPids = (home: string) => join(home, 'lander-checks')
export const sweepChecks = async (home: string) => {
  const isResumedProcessCheck = (name: string) => name.startsWith(`${process.pid}-`)
  await sweepPidFiles(checkPids(home), isResumedProcessCheck)
  const names = await readdir(checkTemp(home)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const name of names)
    if (!name.startsWith(`${process.pid}-`))
      await rm(join(checkTemp(home), name), { recursive: true, force: true })
}
export const checkTemp = (home: string) => join(tmpdir(), `ultimate-lander-${landerHash(home)}`)

export async function runLanderCheck(
  path: string,
  command: string,
  context: Context,
  pids: string,
  temp: string,
  limits: CheckLimits = defaultCheckLimitsSeconds,
  base?: string,
): Promise<CheckRun> {
  const tmp = createTempBeforeWatchdog(temp)
  let output = ''
  let partial = ''
  const failed = new Set<string>()
  let stopped: string | undefined
  const watchdog = new AbortController()
  const signal = AbortSignal.any([
    watchdog.signal,
    ...(context.abortSignal ? [context.abortSignal] : []),
  ])
  const stop = (reason: string) => {
    if (signal.aborted) return
    stopped = reason
    watchdog.abort()
  }
  const stalled = () =>
    stop(`Stalled: no output for ${formatDuration(limits.stall * 1000)}, stopped`)
  const stallDeadline = debounce(limits.stall * 1000, stalled)
  stallDeadline()
  const cancelTotal = deadline(limits.total * 1000, () =>
    stop(`Timed out after ${formatDuration(limits.total * 1000)}`),
  )
  const report = (reason: string, heading: string) => {
    const tests = [...failed].slice(-20)
    const failedFiles = [...failed]
      .filter((test) => test.startsWith('FAIL'))
      .map((test) => test.slice('FAIL'.length).replace(/\s+/g, ' ').trim())
    return {
      failure: [reason, ...(tests.length ? [heading, ...tests] : []), output].join('\n').trim(),
      cause: [reason, ...failedFiles.slice(0, 5)].join(': '),
    }
  }
  const onOutput = (text: string) => {
    output = (output + text).slice(-3000)
    const split = (partial + text).split('\n')
    partial = split.pop()!.slice(-1000)
    for (const line of split) {
      const plain = stripVTControlCharacters(line).trim()
      if (vitestFailureLine.test(plain)) failed.add(plain.slice(0, 300))
    }
    stallDeadline()
  }
  try {
    let exit: Awaited<ReturnType<typeof runGroup>>
    try {
      exit = await runGroup('/bin/bash', ['-c', command], {
        cwd: path,
        env: { ...process.env, TMPDIR: tmp, ...(base && { ULTIMATE_LANDER_BASE: base }) },
        pidFile: join(pids, `${process.pid}-${randomUUID()}.pid`),
        signal,
        grace: 2000,
        onOutput,
      })
    } catch (error) {
      context.abortSignal?.throwIfAborted()
      return { failure: `${output}\n${String(error)}`.trim(), cause: String(error) }
    }
    context.abortSignal?.throwIfAborted()
    if (stopped) return { ...report(stopped, 'Failed tests so far:'), timedOut: true }
    if (exit.outOfMemory) return report(`Out of memory: exit ${exit.code}`, 'Failed tests so far:')
    if (exit.code !== 0) return report(`exit ${exit.code}`, 'Failed tests:')
    const last = lines(stripVTControlCharacters(output)).findLast((line) => line.trim())
    return { summary: last?.trim().slice(0, 200) }
  } finally {
    stallDeadline.cancel()
    cancelTotal()
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
      retriedLater,
    )
  }
}

type CheckRun =
  | { failure?: undefined; summary?: string; timedOut?: undefined }
  | { failure: string; cause: string; summary?: undefined; timedOut?: boolean }

function createTempBeforeWatchdog(temp: string) {
  mkdirSync(temp, { recursive: true })
  return mkdtempSync(join(temp, `${process.pid}-`))
}

const parseCheck = (value: unknown): Check | undefined => {
  if (typeof value === 'string') return { command: value }
  if (!value || typeof value !== 'object') return undefined
  const { command, timeout } = value as { command?: unknown; timeout?: unknown }
  if (typeof command !== 'string') return undefined
  if (timeout === undefined) return { command }
  return typeof timeout === 'number' && timeout > 0 ? { command, timeout } : undefined
}
export const landerSettings = async (host: Pick<Host, 'projectSettings'>): Promise<Settings> => {
  const lander = (await host.projectSettings()).lander as
    | { checks?: unknown; push?: unknown }
    | undefined
  const entries = lander?.checks ?? []
  const checks = Array.isArray(entries)
    ? entries.map((entry) =>
        Array.isArray(entry)
          ? entry.length > 0
            ? entry.map(parseCheck)
            : [undefined]
          : parseCheck(entry),
      )
    : undefined
  if (!checks?.every((group) => (Array.isArray(group) ? group.every(Boolean) : group)))
    throw new Error(
      'lander.checks must be an array of checks or check groups; a check is a command or { "command", "timeout" } with timeout in seconds',
    )
  if (lander?.push !== undefined && typeof lander.push !== 'string')
    throw new Error('lander.push must be a remote name')
  const pushOutsidePreview =
    lander?.push && !process.env.ULTIMATE_PREVIEW_BRANCH ? lander.push : undefined
  return {
    checks: checks as Settings['checks'],
    ...(pushOutsidePreview ? { push: pushOutsidePreview } : {}),
  }
}
export const contains = (cwd: string, ancestor: string, descendant: string) =>
  git(cwd, 'merge-base', '--is-ancestor', ancestor, descendant).then(
    () => true,
    () => false,
  )
const lines = (text: string) => text.split('\n').filter(Boolean)
const failure = (error: unknown) => {
  const output = error as Error & { stdout?: string; stderr?: string }
  return `${output.stdout ?? ''}${output.stderr ?? ''}${output.stdout || output.stderr ? '' : output.message}`
    .trim()
    .slice(-3000)
}
const remote = (cwd: string, signal: AbortSignal, ...args: string[]) =>
  git({ cwd, signal, timeout: 300000 }, ...args)

type CheckedIntegration = {
  base: string
  integrated: string
  flaky: string[]
}
const landedOutcome = (landed: Landed): LanderOutcome => ({
  outcome: 'landed',
  sha: landed.sha,
  base: landed.base,
  commits: landed.commits,
  paths: landed.paths,
  flaky: landed.flaky,
  ...(landed.weight ? { weight: landed.weight } : {}),
})
type CommittedDeliveryDecision = {
  phase: 'deliver'
  id: string
  conversationId: ConversationId
  headline: string
  outcome: WorkspaceIndex['results'][string]
  concluded: boolean
  starter?: ConversationId
}
type ConcludedBranchRelease = { phase: 'release'; conversationId: ConversationId }

type BranchReportHeldAsNote = ConversationId
type UnderwayReportPhase = {
  phase: 'report'
  id: string
  conversationId: BranchReportHeldAsNote
  text: string
  headline: string
  outcome: WorkspaceIndex['results'][string]
}

type State =
  | { phase: 'next' }
  | { phase: 'land'; id: string; attempt: number; pushRetried?: boolean }
  | UnderwayReportPhase
  | CommittedDeliveryDecision
  | { phase: 'card-failed'; error: string }
  | ConcludedBranchRelease

export async function hasPendingLanderReport(tx: Tx, index: WorkspaceIndex, id: ConversationId) {
  for (const taskId of Object.values(index.landers)) {
    const state = (await tx.task(taskId))?.state
    if (!state || state.status === 'terminal') continue
    const checkpoint = state.checkpoint as State | undefined
    if (checkpoint?.phase === 'report' && checkpoint.conversationId === id) return true
  }
  return false
}

export async function activeLandingCards(tx: Tx, index: WorkspaceIndex) {
  const results: string[] = []
  for (const taskId of Object.values(index.landers)) {
    const task = await tx.task(taskId)
    const checkpoint = task?.state.checkpoint as State | undefined
    if (checkpoint?.phase === 'deliver' && checkpoint.concluded && checkpoint.starter !== undefined)
      results.push(checkpoint.id)
  }
  return results
}

export function createLander(
  host: Host,
  Workspaces: ConversationDocToken<WorkspaceIndex>,
  serializeSourceWrites: <T>(source: string, operation: () => Promise<T>) => Promise<T>,
  after: {
    starter: (id: ConversationId, context: Context) => Promise<ConversationId | undefined>
    working: (tx: Tx, id: ConversationId) => Promise<boolean>
    conclude: (tx: Tx, id: ConversationId) => Promise<void>
    reserveLanding: import('./api.ts').BranchesService['reserveLanding']
    retireLanding: import('./api.ts').BranchesService['retireLanding']
    submitLanding: import('./api.ts').BranchesService['submitLanding']
    release: (id: ConversationId, context: Context) => Promise<unknown>
  },
  limits: CheckLimits = defaultCheckLimitsSeconds,
) {
  async function resetTrackedIntegration(source: string, tip: string) {
    const path = await landerCheckout(host.home, source, await host.projectSettings(), tip)
    await git(path, 'reset', '--hard', '-q')
    await git(path, 'checkout', '-q', '--detach', '--force', tip)
    await git(path, 'clean', '-fdq')
    return path
  }

  const Lander = defineTask<{ source: string }, State, null>({
    name: 'workspaces.lander',
    version: 1,
    initial: () => ({ phase: 'next' }),
    phases: {
      next: (task, runtime, context) =>
        runtime.commit(async (tx) => {
          const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
          const entry = index.queue.find((item) => item.source === task.input.source)
          if (!entry) {
            delete index.landers[task.input.source]
            return { status: 'terminal', outcome: { status: 'completed', result: null } }
          }
          entry.state = 'landing'
          await log(tx, runtime.conversationId, entry, { step: 'started' })
          return { status: 'running', checkpoint: { phase: 'land', id: entry.id, attempt: 1 } }
        }, context),
      land: async (task, runtime, context) => {
        const { id, attempt, pushRetried } = task.state.checkpoint
        const { signal } = runtime
        const index = (await runtime.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
        const entry = index.queue.find((item) => item.id === id)!
        const recordedFirstFastForward = async () =>
          (await runtime.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!.queue.find(
            (item) => item.id === id,
          )?.landed
        const step = (
          text: string,
          {
            runs,
            result,
            output,
            ran,
          }: {
            runs?: string
            result?: LanderEntry['check']
            output?: string
            ran?: { ms: number; timedOut?: boolean }
          } = {},
        ) =>
          runtime.commit(async (tx) => {
            const saved = (await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).queue.find(
              (item) => item.id === id,
            )!
            saved.step = text
            await log(tx, runtime.conversationId, saved, {
              step: text,
              ...(runs ? { runs } : {}),
              ...(result ? { check: result } : {}),
              ...(output ? { output } : {}),
            })
            if (result && ran)
              await host.emit(tx, CheckRan, {
                submission: id,
                command: result.command,
                result: ran.timedOut ? 'timeout' : result.result,
                ms: Math.round(ran.ms),
              })
          }, context)
        const commitLandingOutcome = (text: string, outcome: LanderOutcome, sha = outcome.sha) =>
          runtime.commit(async (tx) => {
            const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
            const steps = draft.queue.find((item) => item.id === id)!.steps
            draft.queue = draft.queue.filter((item) => item.id !== id)
            if (outcome.sha) draft.items[String(entry.conversationId)].landed = outcome.sha
            draft.results[id] = {
              ...outcome,
              at: entry.at,
              divergence: entry.divergence,
              target: entry.target,
              tip: entry.tip,
              lander: runtime.conversationId,
              steps,
              conversationId: entry.conversationId,
              ...(entry.subject ? { subject: entry.subject } : {}),
            }
            for (const old of Object.keys(draft.results).slice(0, -recentSubmitCardOutcomeLimit))
              delete draft.results[old]
            await log(tx, runtime.conversationId, entry, outcome)
            if (outcome.outcome === 'failed')
              await host.emit(tx, SubmissionFailed, {
                submission: id,
                conversationId: entry.conversationId,
                target: entry.target,
                reason: outcome.reason ?? '',
              })
            if (outcome.outcome === 'landed') {
              const subject = entry.subject ?? {}
              const commits = (outcome.commits ?? []).map((commit) => {
                const space = commit.indexOf(' ')
                return { sha: commit.slice(0, space), subject: commit.slice(space + 1) }
              })
              await host.emit(tx, SubmissionLanded, {
                submission: id,
                conversationId: entry.conversationId,
                at: entry.at,
                sha: outcome.sha!,
                base: outcome.base!,
                target: entry.target,
                lander: runtime.conversationId,
                divergence: entry.divergence,
                title:
                  subject.title ?? (await tx.doc(host.metadata, entry.conversationId)).title ?? '',
                ...(subject.summary ? { summary: subject.summary } : {}),
                ...(subject.feature ? { feature: subject.feature } : {}),
                commits: commits.slice(0, 10),
                commitCount: commits.length,
                paths: (outcome.paths ?? []).slice(0, 8),
                ...(outcome.pushed ? { pushed: outcome.pushed } : {}),
              })
            }
            return {
              status: 'running',
              checkpoint: {
                phase: 'report',
                id,
                conversationId: entry.conversationId,
                outcome: draft.results[id],
                headline: starterLine(entry.conversationId, sha ?? '', draft.results[id]),
                text: `[lander] Submission ${id} (#${entry.conversationId}, ${entry.tip.slice(0, 7)}) ${text}\nLog: lander conversation #${runtime.conversationId}.`,
              },
            }
          }, context)
        const summary = (landed: Landed, sha: string, how = '') =>
          [
            landed.commits.length
              ? `landed${how} as ${sha.slice(0, 7)} on ${entry.target}.`
              : `had nothing new to land on ${entry.target}.`,
            ...(landed.commits.length ? [`Commits:\n${landed.commits.join('\n')}`] : []),
            ...landed.flaky.map((command) => `Flaky: ${command}`),
          ].join('\n')
        const fail = async (reason: string, output?: string, hint?: string) => {
          const landed = await recordedFirstFastForward()
          const detail = [output ? `${reason}:\n${output}` : reason, ...(hint ? [hint] : [])].join(
            '\n',
          )
          const facts = {
            reason: landed ? `Push failed: ${reason}` : reason,
            ...(output ? { output } : {}),
            ...(hint ? { hint } : {}),
          }
          return landed
            ? commitLandingOutcome(
                `${summary(landed, landed.sha, ' locally')}\nPush failed: ${detail}`,
                {
                  ...landedOutcome(landed),
                  ...facts,
                },
              )
            : commitLandingOutcome(`was not landed: ${detail}`, {
                outcome: 'failed',
                ...facts,
              })
        }
        const retry = (retried = pushRetried) =>
          runtime.commit(
            () => ({
              status: 'running',
              checkpoint: {
                phase: 'land',
                id,
                attempt: attempt + 1,
                ...(retried ? { pushRetried: retried } : {}),
              },
            }),
            context,
          )
        const { source, target } = entry
        const checkContext = withAbortSignal(signal, context)
        const push = async (settings: Settings, checkedCommit: string) => {
          if (!settings.push) return { text: 'Not pushed.' }
          await step(`pushing to ${settings.push}`)
          try {
            await remote(
              source,
              signal,
              'push',
              '-q',
              settings.push,
              `${checkedCommit}:refs/heads/${target}`,
            )
            return {
              remote: `${settings.push}/${target}`,
              text: `Pushed to ${settings.push}/${target}.`,
            }
          } catch (error) {
            if (signal.aborted) throw error
            if (!pushRetried) return { retry: retry(true) }
            return { retry: fail(`${settings.push} rejected the push`, failure(error)) }
          }
        }
        const landedReport = async (settings: Settings, landed: Landed, sha: string) => {
          const pushed = await push(settings, sha)
          if (pushed.retry) return pushed.retry
          const needsRestart =
            (await realpath(source)) === (await realpath(host.ultimateRoot)) &&
            restartNeeded(landed.paths)
          return commitLandingOutcome(
            [summary(landed, sha), pushed.text, ...(needsRestart ? ['Needs restart.'] : [])].join(
              '\n',
            ),
            {
              ...landedOutcome(landed),
              ...(pushed.remote ? { pushed: pushed.remote } : {}),
              ...(needsRestart ? { needsRestart } : {}),
            },
            sha,
          )
        }
        try {
          const settings = await landerSettings(host)
          const landingFromEarlierTask = entry.landed
          if (
            landingFromEarlierTask &&
            attempt === 1 &&
            !pushRetried &&
            (await contains(source, landingFromEarlierTask.sha, `refs/heads/${target}`))
          )
            return await landedReport(settings, landingFromEarlierTask, landingFromEarlierTask.sha)
          let checkedIntegration = await runtime.memo<CheckedIntegration>(
            `prepared:${id}:${attempt}`,
            context,
          )
          if (!checkedIntegration) {
            let mergedBeforeChecks = await runtime.memo<{ base: string; sha: string }>(
              `merged:${id}:${attempt}`,
              context,
            )
            const path = await resetTrackedIntegration(
              source,
              mergedBeforeChecks?.sha ?? (await git(source, 'rev-parse', `refs/heads/${target}`)),
            )
            if (!mergedBeforeChecks) {
              await step('preparing')
              const base = await git(path, 'rev-parse', 'HEAD')
              const mergeOrReportConflict = async (
                commit: string,
                message: string,
                reason: string,
                hint: string,
              ) => {
                try {
                  await git(path, 'merge', '--no-edit', '-m', message, commit)
                  return false
                } catch {
                  const conflicts = await git(path, 'diff', '--name-only', '--diff-filter=U')
                  await git(path, 'merge', '--abort').catch(overshadowed)
                  await fail(reason, conflicts, hint)
                  return true
                }
              }
              if (settings.push) {
                if (
                  await remote(path, signal, 'ls-remote', settings.push, `refs/heads/${target}`)
                ) {
                  await remote(path, signal, 'fetch', '-q', settings.push, target)
                  const fetched = await git(path, 'rev-parse', 'FETCH_HEAD')
                  if (!(await contains(path, fetched, 'HEAD'))) {
                    await step(`merging ${settings.push}/${target}`)
                    if (
                      await mergeOrReportConflict(
                        fetched,
                        `Merge ${settings.push}/${target}`,
                        `${settings.push}/${target} conflicts with local ${target}`,
                        `Reconcile ${settings.push}/${target} with local ${target}, then submit again.`,
                      )
                    )
                      return
                  }
                }
              }
              await step('merging')
              if (
                await mergeOrReportConflict(
                  entry.tip,
                  `Merge ${entry.tip.slice(0, 7)} from #${entry.conversationId} into ${target}\n\nUltimate-Conversation: ${entry.conversationId}`,
                  `it conflicts with ${target} in`,
                  `Merge ${target} into your workspace, resolve, verify and submit again.`,
                )
              )
                return
              mergedBeforeChecks = await runtime.memo(
                `merged:${id}:${attempt}`,
                { base, sha: await git(path, 'rev-parse', 'HEAD') },
                context,
              )
            }
            const { base } = mergedBeforeChecks
            await step('setting up')
            await setup(source, path, await host.projectSettings(), signal)
            const flaky: string[] = []
            for (const [position, group] of settings.checks.entries()) {
              const members = Array.isArray(group) ? group : [group]
              const commands = members.map((check) => check.command)
              const run = (command: string, member: number) =>
                runLanderCheck(
                  path,
                  command,
                  checkContext,
                  checkPids(host.home),
                  checkTemp(host.home),
                  limitsFor(members[member], limits),
                  base,
                )
              const runCheckWithOneDurableRerun = async (command: string, member: number) => {
                const attemptMemoKey = `check:${id}:${attempt}:${Array.isArray(group) ? `${position}.${member}` : position}`
                const causeMemoKey = `${attemptMemoKey}:cause`
                let memoizedFirstRun =
                  (await runtime.memo<'passed' | 'failed'>(attemptMemoKey, context)) ??
                  ((await runtime.memo<string>(causeMemoKey, context)) ? 'failed' : undefined)
                if (!memoizedFirstRun) {
                  await step(`checking: ${command}`, { runs: command })
                  const began = performance.now()
                  const ran = await run(command, member)
                  const ms = performance.now() - began
                  const unmemoizedResult = ran.failure === undefined ? 'passed' : 'failed'
                  const logAttemptBeforeMemo = step
                  await logAttemptBeforeMemo(`checked: ${command}`, {
                    result: {
                      command,
                      result: unmemoizedResult,
                      ...(ran.summary ? { summary: ran.summary } : {}),
                    },
                    output: ran.failure,
                    ran: { ms, timedOut: ran.timedOut },
                  })
                  if (ran.failure !== undefined)
                    await runtime.memo(causeMemoKey, ran.cause, context)
                  memoizedFirstRun = await runtime.memo(attemptMemoKey, unmemoizedResult, context)
                }
                if (memoizedFirstRun === 'passed') return {}
                let rerun = await runtime.memo<{ failure?: string }>(
                  `${attemptMemoKey}:rerun`,
                  context,
                )
                if (!rerun) {
                  await step(`rerunning: ${command}`, { runs: command })
                  const began = performance.now()
                  const ran = await run(command, member)
                  const timing = { ms: performance.now() - began, timedOut: ran.timedOut }
                  if (ran.failure === undefined)
                    await step(`checked: ${command}`, {
                      result: {
                        command,
                        result: 'flaky',
                        ...(ran.summary ? { summary: ran.summary } : {}),
                      },
                      ran: timing,
                    })
                  else
                    await runtime.commit(async (tx) => {
                      await host.emit(tx, CheckRan, {
                        submission: id,
                        command,
                        result: ran.timedOut ? 'timeout' : 'failed',
                        ms: Math.round(timing.ms),
                      })
                    }, context)
                  rerun = await runtime.memo<{ failure?: string }>(
                    `${attemptMemoKey}:rerun`,
                    ran.failure === undefined ? {} : { failure: ran.failure },
                    context,
                  )
                }
                if (rerun.failure !== undefined) return { failure: rerun.failure }
                const cause = await runtime.memo<string>(causeMemoKey, context)
                return { flaky: cause ? `${command} · ${cause}` : command }
              }
              const settledCheckGroup = await Promise.allSettled(
                commands.map(runCheckWithOneDurableRerun),
              )
              const results = settledCheckGroup.map((outcome) => {
                if (outcome.status === 'rejected') throw outcome.reason
                return outcome.value
              })
              const failed = results.findIndex((result) => result.failure !== undefined)
              if (failed !== -1)
                return await fail(
                  `check failed twice: ${commands[failed]}`,
                  results[failed].failure,
                  'Fix it at its cause (a flaky test too: fix or delete it), verify and submit again.',
                )
              flaky.push(...results.flatMap((result) => result.flaky ?? []))
            }
            const checkedTreeChanged =
              (await git(path, 'rev-parse', 'HEAD')) !== mergedBeforeChecks.sha ||
              (await git(path, 'status', '--porcelain'))
            if (checkedTreeChanged)
              return await fail(
                'the integration checkout changed during checks',
                `${await git(path, 'log', '--oneline', '-3')}\n${await git(path, 'status', '--short')}`.trim(),
                'Submit again.',
              )
            checkedIntegration = await runtime.memo<CheckedIntegration>(
              `prepared:${id}:${attempt}`,
              { base, integrated: mergedBeforeChecks.sha, flaky },
              context,
            )
          }
          const { base, integrated, flaky } = checkedIntegration
          await step('fast-forwarding')
          let refused: string | undefined
          const moved = await serializeSourceWrites(source, async () => {
            const current = await git(source, 'rev-parse', `refs/heads/${target}`)
            const replayAfterFastForward = current === integrated
            if (replayAfterFastForward) return false
            if (current !== base) return true
            try {
              const checkoutHoldingTargetBranch = (
                await git(source, 'worktree', 'list', '--porcelain')
              )
                .split('\n\n')
                .map((record) => record.split('\n'))
                .find((record) => record.includes(`branch refs/heads/${target}`))?.[0]
                .slice('worktree '.length)
              if (checkoutHoldingTargetBranch)
                await git(checkoutHoldingTargetBranch, 'merge', '-q', '--ff-only', integrated)
              else await git(source, 'update-ref', `refs/heads/${target}`, integrated, base)
            } catch (error) {
              refused = failure(error)
            }
            return false
          })
          if (refused)
            return fail(
              `the checkout of ${target} refused the fast-forward to ${integrated.slice(0, 7)}`,
              refused,
            )
          if (moved) {
            if (attempt < maxTargetMoveAttempts) return retry()
            return fail(`${target} kept moving during ${maxTargetMoveAttempts} attempts.`)
          }
          const weight = await landingWeight(source, base, integrated)
          const firstFastForwardCandidate: Landed = {
            sha: integrated,
            base,
            commits: lines(await git(source, 'log', '--oneline', `${base}..${integrated}`)),
            paths: lines(await git(source, 'diff', '--name-only', base, integrated)),
            flaky,
            ...(weight ? { weight } : {}),
          }
          let landed = firstFastForwardCandidate
          await runtime.commit(async (tx) => {
            const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
            const saved = draft.queue.find((item) => item.id === id)!
            saved.landed ??= firstFastForwardCandidate
            landed = copyJson(saved.landed) as Landed
            draft.items[String(entry.conversationId)].landed = integrated
          }, context)
          return await landedReport(settings, landed, integrated)
        } catch (error) {
          if (signal.aborted) throw error
          return fail('it failed', failure(error))
        }
      },
      report: async (task, runtime, context) => {
        const { id, conversationId, text, headline, outcome } = task.state.checkpoint
        const branch = conversationId
        const entry = { kind: LanderReportEntry.kind, data: { id, outcome } }
        const next = { status: 'running', checkpoint: { phase: 'next' } } as const
        if (outcome.outcome === 'failed') {
          await (
            await runtime.conversation(branch, context)
          )?.submit(
            {
              type: 'input',
              content: text,
              entry,
              whenBusy: 'followUp',
              requestId: `lander:${id}`,
            },
            context,
          )
          await runtime.commit(() => next, context)
          return
        }
        await (
          await host.harness().conversation(branch, context)
        )?.submit(
          {
            type: 'write',
            requestId: `lander:${id}`,
            entry: { ...entry, model: [{ role: 'user', content: text, timestamp: Date.now() }] },
          },
          context,
        )
        const starter = await after.starter(branch, context)
        await runtime.commit(async (tx) => {
          let concludedInThisCommit = false
          if (!(await after.working(tx, branch)))
            try {
              await after.conclude(tx, branch)
              concludedInThisCommit = true
            } catch (error) {
              host.notice(`Not concluding #${branch} after landing: ${String(error)}`)
            }
          if (concludedInThisCommit && starter !== undefined && starter !== branch)
            await after.reserveLanding(tx, branch, id)
          return {
            status: 'running',
            checkpoint: {
              phase: 'deliver',
              id,
              conversationId,
              headline,
              outcome,
              concluded: concludedInThisCommit,
              ...(starter !== undefined && starter !== branch ? { starter } : {}),
            },
          }
        }, context)
      },
      deliver: async (task, runtime, context) => {
        const {
          id,
          conversationId,
          headline,
          outcome,
          concluded: conclusionCommitted,
          starter,
        } = task.state.checkpoint
        const entry = { kind: LanderReportEntry.kind, data: { id, outcome } }
        const content = `${headline}\nDiverged: ${outcome.divergence}\n${conclusionCommitted ? `#${conversationId} is concluded.` : `#${conversationId} still has work under way; it reports when it stops.`}`
        try {
          const to =
            starter === undefined ? undefined : await runtime.conversation(starter, context)
          await runtime.commit(async (tx) => {
            if (to && conclusionCommitted)
              await after.submitLanding(
                tx,
                to,
                { type: 'input', content, entry, whenBusy: 'followUp', requestId: `lander:${id}` },
                conversationId,
                id,
              )
            else if (to)
              await to.submit(tx, {
                type: 'write',
                requestId: `lander:${id}`,
                entry: { ...entry, model: [{ role: 'user', content, timestamp: Date.now() }] },
              })
            else if (conclusionCommitted && starter !== undefined) await after.retireLanding(tx, id)
            return {
              status: 'running',
              checkpoint: conclusionCommitted
                ? { phase: 'release', conversationId }
                : { phase: 'next' },
            }
          }, context)
        } catch (error) {
          if (runtime.signal.aborted || !conclusionCommitted || starter === undefined) throw error
          await runtime.commit(async (tx) => {
            await after.retireLanding(tx, id)
            return {
              status: 'running',
              checkpoint: {
                phase: 'card-failed',
                error: error instanceof Error ? error.message : String(error),
              },
            }
          }, context)
        }
      },
      'card-failed': (task) => {
        throw new Error(task.state.checkpoint.error)
      },
      release: async (task, runtime, context) => {
        await after
          .release(task.state.checkpoint.conversationId, context)
          .catch((error: unknown) => {
            context.abortSignal?.throwIfAborted()
            host.notice(
              `Releasing #${task.state.checkpoint.conversationId} failed: ${String(error)}`,
            )
          })
        await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'next' } }), context)
      },
    },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
        if (index.landers[task.input.source] === task.id) delete index.landers[task.input.source]
        for (const item of index.queue)
          if (item.source === task.input.source) {
            item.state = 'queued'
            delete item.step
          }
        const checkpoint = task.state.checkpoint
        if (
          checkpoint.phase === 'deliver' &&
          checkpoint.concluded &&
          checkpoint.starter !== undefined
        )
          await after.retireLanding(tx, checkpoint.id)
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, context),
  })
  return Lander
}
