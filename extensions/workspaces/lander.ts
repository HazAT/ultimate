import type {
  ConversationId,
  JsonObject,
  ConversationDocToken,
  Tx,
  TaskRuntime,
} from '@earendil-works/pi-durable'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { copyJson } from '@earendil-works/chord/json'
import type { Context } from '@earendil-works/chord/context'
import { withAbortSignal } from '@earendil-works/chord/context'
import { defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { debounce, deadline, pace } from '../../lib/timers.ts'
import { git } from '../../lib/git.ts'
import { overshadowed, retriedLater, settled } from '../../lib/errors.ts'
import { needsRestart as restartNeeded } from '../../lib/layers.ts'
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
  batch: number
}
const maxTargetMoveAttempts = 3
type CheckLimits = { stall: Seconds; total: Seconds }
const defaultCheckLimitsSeconds: CheckLimits = { stall: 2 * 60, total: 10 * 60 }
export const limitsFor = (check: Check, limits: CheckLimits): CheckLimits =>
  check.timeout === undefined
    ? limits
    : { stall: Math.min(limits.stall, check.timeout), total: check.timeout }
const vitestFailureLine = /^\s*(FAIL|×|✗)\s/
const seconds = (value: number) => (value < 60 ? `${value} s` : `${+(value / 60).toFixed(1)} min`)

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
export const checkTemp = (home: string) => join(home, 'lander-tmp')

export async function runLanderCheck(
  path: string,
  command: string,
  context: Context,
  pids: string,
  temp: string,
  limits: CheckLimits = defaultCheckLimitsSeconds,
) {
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
  const stalled = () => stop(`Stalled: no output for ${seconds(limits.stall)}, stopped`)
  const stallDeadline = debounce(limits.stall * 1000, stalled)
  stallDeadline()
  const cancelTotal = deadline(limits.total * 1000, () =>
    stop(`Timed out after ${seconds(limits.total)}`),
  )
  const report = (reason: string, heading: string) => {
    const tests = [...failed].slice(-20)
    return [reason, ...(tests.length ? [heading, ...tests] : []), output].join('\n').trim()
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
    let exitCode: number
    try {
      exitCode = await runGroup('/bin/bash', ['-c', command], {
        cwd: path,
        env: { ...process.env, TMPDIR: tmp },
        pidFile: join(pids, `${process.pid}-${randomUUID()}.pid`),
        signal,
        grace: 2000,
        onOutput,
      })
    } catch (error) {
      context.abortSignal?.throwIfAborted()
      return { failure: `${output}\n${String(error)}`.trim() }
    }
    context.abortSignal?.throwIfAborted()
    if (stopped) return { failure: report(stopped, 'Failed tests so far:'), timedOut: true }
    if (exitCode !== 0) return { failure: report(`exit ${exitCode}`, 'Failed tests:') }
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
    | { checks?: unknown; push?: unknown; batch?: unknown }
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
  const batch = lander?.batch ?? 3
  if (!Number.isInteger(batch) || (batch as number) < 1)
    throw new Error('lander.batch must be a whole number of submissions, at least 1')
  return {
    checks: checks as Settings['checks'],
    ...(pushOutsidePreview ? { push: pushOutsidePreview } : {}),
    batch: batch as number,
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
const unreachableText =
  /Could not resolve (host|hostname|proxy)|Temporary failure in name resolution|nodename nor servname|Failed to connect to|Could not connect to server|Connection (refused|reset|timed out)|Operation timed out|Network is unreachable|No route to host|SSL_ERROR_SYSCALL/i
export const unreachable = (error: unknown) =>
  (error as { killed?: boolean }).killed === true || unreachableText.test(failure(error))
export type NetworkWait = { first: number; most: number; tell: number }
const networkWait: NetworkWait = { first: 30, most: 5 * 60, tell: 30 * 60 }
type Offline = {
  waiting: (reason: string) => Promise<void>
  long: (reason: string, minutes: number) => Promise<void>
  back: (minutes: number) => Promise<void>
}
export async function whenOnline<T>(
  call: () => Promise<T>,
  probe: () => Promise<unknown>,
  signal: AbortSignal,
  offline: Offline,
  timing: NetworkWait = networkWait,
): Promise<T> {
  for (;;) {
    try {
      return await call()
    } catch (error) {
      if (signal.aborted || !unreachable(error)) throw error
      const reason = lines(failure(error)).at(-1) ?? 'unreachable'
      await offline.waiting(reason)
      const since = Date.now()
      const minutes = () => Math.round((Date.now() - since) / 60000)
      let told = false
      for (let delay = timing.first; ; delay = Math.min(delay * 2, timing.most)) {
        await pace(delay * 1000, signal)
        const reached = await probe().then(
          () => true,
          (failed: unknown) => {
            if (signal.aborted) throw failed
            return !unreachable(failed)
          },
        )
        if (reached) break
        if (!told && Date.now() - since >= timing.tell * 1000) {
          told = true
          await offline.long(reason, minutes())
        }
      }
      await offline.back(minutes())
    }
  }
}

type CheckedIntegration = {
  base: string
  integrated: string
  flaky: string[]
}
type Runtime = TaskRuntime<{ source: string }, State, null, object>
type Step = (
  text: string,
  options?: {
    runs?: string
    result?: LanderEntry['check']
    output?: string
    ran?: { ms: number; timedOut?: boolean }
  },
) => Promise<void>
const batchLine = (batch: string, members: readonly QueueEntry[]) => ({
  id: batch,
  conversationId: members[0].conversationId,
  tip: members[0].tip,
  target: members[0].target,
  at: members[0].at,
  divergence: members[0].divergence,
  steps: [],
})
const mergeMessage = (entry: QueueEntry) =>
  `Merge ${entry.tip.slice(0, 7)} from #${entry.conversationId} into ${entry.target}\n\nUltimate-Conversation: ${entry.conversationId}`
async function tryMerge(path: string, commit: string, message: string) {
  try {
    await git(path, 'merge', '--no-edit', '-m', message, commit)
    return undefined
  } catch {
    const conflicts = await git(path, 'diff', '--name-only', '--diff-filter=U')
    await git(path, 'merge', '--abort').catch(overshadowed)
    return conflicts
  }
}
type Remote = (cwd: string, ...args: string[]) => Promise<string>
async function remoteAhead(path: string, push: string | undefined, target: string, run: Remote) {
  if (!push || !(await run(path, 'ls-remote', push, `refs/heads/${target}`))) return undefined
  await run(path, 'fetch', '-q', push, target)
  const fetched = await git(path, 'rev-parse', 'FETCH_HEAD')
  return (await contains(path, fetched, 'HEAD')) ? undefined : fetched
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
  text: string
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
  outcome: WorkspaceIndex['results'][string]
}

type State =
  | { phase: 'next' }
  | { phase: 'land'; id: string; attempt: number; pushRetried?: boolean }
  | { phase: 'batch'; batch: string; ids: string[]; attempt: number }
  | UnderwayReportPhase
  | CommittedDeliveryDecision
  | ConcludedBranchRelease

export function createLander(
  host: Host,
  Workspaces: ConversationDocToken<WorkspaceIndex>,
  serializeSourceWrites: <T>(source: string, operation: () => Promise<T>) => Promise<T>,
  after: {
    starter: (id: ConversationId, context: Context) => Promise<ConversationId | undefined>
    working: (tx: Tx, id: ConversationId) => Promise<boolean>
    conclude: (tx: Tx, id: ConversationId) => Promise<void>
    release: (id: ConversationId, context: Context) => Promise<unknown>
    ultimate: (context: Context) => Promise<ConversationId | undefined>
  },
  limits: CheckLimits = defaultCheckLimitsSeconds,
  network: NetworkWait = networkWait,
) {
  async function resetTrackedIntegration(source: string, tip: string) {
    const path = await landerCheckout(host.home, source, await host.projectSettings(), tip)
    await git(path, 'reset', '--hard', '-q')
    await git(path, 'checkout', '-q', '--detach', '--force', tip)
    await git(path, 'clean', '-fdq')
    return path
  }
  const stepper =
    (runtime: Runtime, context: Context, submission: string, ids: readonly string[]): Step =>
    (text, { runs, result, output, ran } = {}) =>
      runtime.commit(async (tx) => {
        const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
        const members = ids.map((id) => draft.queue.find((item) => item.id === id)!)
        const data = {
          step: text,
          ...(runs ? { runs } : {}),
          ...(result ? { check: result } : {}),
          ...(output ? { output } : {}),
        }
        if (members.length === 1 && members[0].id === submission)
          await log(tx, runtime.conversationId, members[0], data)
        else {
          await log(tx, runtime.conversationId, batchLine(submission, members), data)
          const at = Date.now()
          for (const member of members)
            member.steps.push({
              step: text,
              at,
              ...(runs ? { runs } : {}),
              ...(result ? { check: result } : {}),
            })
        }
        for (const member of members) member.step = text
        if (result && ran)
          await host.emit(tx, CheckRan, {
            submission,
            command: result.command,
            result: ran.timedOut ? 'timeout' : result.result,
            ms: Math.round(ran.ms),
          })
      }, context)
  const online =
    (
      runtime: Runtime,
      context: Context,
      step: Step,
      source: string,
      push: string | undefined,
    ): Remote =>
    (cwd, ...args) =>
      whenOnline(
        () => remote(cwd, runtime.signal, ...args),
        async () => push && remote(cwd, runtime.signal, 'ls-remote', push, 'HEAD'),
        runtime.signal,
        {
          waiting: (reason) => step('waiting for network', { output: reason }),
          long: async (reason, minutes) => {
            const index = (await runtime.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
            const waiting = index.queue.filter((item) => item.source === source)
            const count =
              waiting.length === 1 ? '1 submission waits' : `${waiting.length} submissions wait`
            const text = `[lander] No network for ${minutes} min (${reason}). ${count} in the queue (${waiting.map((item) => `#${item.conversationId}`).join(', ')}); the lander keeps them in place and lands them when the network is back.\nLog: lander conversation #${runtime.conversationId}.`
            await step(`still waiting for network after ${minutes} min`)
            host.notice(text)
            const ultimate = await after.ultimate(context)
            if (ultimate)
              await (
                await runtime.conversation(ultimate, context)
              )?.submit(
                {
                  type: 'input',
                  content: text,
                  whenBusy: 'followUp',
                  requestId: `lander-offline:${runtime.conversationId}:${Date.now()}`,
                },
                context,
              )
          },
          back: (minutes) => step(`network back after ${minutes} min`),
        },
        network,
      )
  async function runChecks(
    runtime: Runtime,
    context: Context,
    checks: Settings['checks'],
    path: string,
    key: string,
    submission: string,
    step: Step,
  ): Promise<{ flaky: string[]; failed?: { command: string; output: string } }> {
    const checkContext = withAbortSignal(runtime.signal, context)
    const flaky: string[] = []
    for (const [position, group] of checks.entries()) {
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
        )
      const runCheckWithOneDurableRerun = async (command: string, member: number) => {
        const attemptMemoKey = `check:${key}:${Array.isArray(group) ? `${position}.${member}` : position}`
        let memoizedFirstRun = await runtime.memo<'passed' | 'failed'>(attemptMemoKey, context)
        if (!memoizedFirstRun) {
          await step(`checking: ${command}`, { runs: command })
          const began = performance.now()
          const ran = await run(command, member)
          const unmemoizedResult = ran.failure === undefined ? 'passed' : 'failed'
          const logAttemptBeforeMemo = step
          await logAttemptBeforeMemo(`checked: ${command}`, {
            result: {
              command,
              result: unmemoizedResult,
              ...(ran.summary ? { summary: ran.summary } : {}),
            },
            output: ran.failure,
            ran: { ms: performance.now() - began, timedOut: ran.timedOut },
          })
          memoizedFirstRun = await runtime.memo(attemptMemoKey, unmemoizedResult, context)
        }
        if (memoizedFirstRun === 'passed') return {}
        let rerun = await runtime.memo<{ failure?: string }>(`${attemptMemoKey}:rerun`, context)
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
                submission,
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
        return rerun.failure === undefined ? { flaky: true } : { failure: rerun.failure }
      }
      const settledCheckGroup = await Promise.allSettled(commands.map(runCheckWithOneDurableRerun))
      const results = settledCheckGroup.map((outcome) => {
        if (outcome.status === 'rejected') throw outcome.reason
        return outcome.value
      })
      const failed = results.findIndex((result) => result.failure !== undefined)
      if (failed !== -1)
        return { flaky, failed: { command: commands[failed], output: results[failed].failure! } }
      flaky.push(...commands.filter((_command, member) => results[member].flaky))
    }
    return { flaky }
  }
  const unchanged = async (path: string, sha: string) =>
    (await git(path, 'rev-parse', 'HEAD')) === sha && !(await git(path, 'status', '--porcelain'))
  const fastForward = (source: string, target: string, base: string, integrated: string) =>
    serializeSourceWrites(source, async (): Promise<{ moved?: true; refused?: string }> => {
      const current = await git(source, 'rev-parse', `refs/heads/${target}`)
      if (current === integrated) return {}
      if (current !== base)
        return (await contains(source, integrated, current)) ? {} : { moved: true }
      try {
        const worktree = (await git(source, 'worktree', 'list', '--porcelain'))
          .split('\n\n')
          .map((record) => record.split('\n'))
          .find((record) => record.includes(`branch refs/heads/${target}`))?.[0]
          .slice('worktree '.length)
        if (worktree) await git(worktree, 'merge', '-q', '--ff-only', integrated)
        else await git(source, 'update-ref', `refs/heads/${target}`, integrated, base)
      } catch (error) {
        return { refused: failure(error) }
      }
      return {}
    })

  const Lander = defineTask<{ source: string }, State, null>({
    name: 'workspaces.lander',
    version: 1,
    initial: () => ({ phase: 'next' }),
    phases: {
      next: async (task, runtime, context) => {
        const size = await landerSettings(host).then(
          (settings) => settings.batch,
          () => 1,
        )
        await runtime.commit(async (tx) => {
          const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
          const waiting = index.queue.filter((item) => item.source === task.input.source)
          const [entry] = waiting
          if (!entry) {
            delete index.landers[task.input.source]
            return { status: 'terminal', outcome: { status: 'completed', result: null } }
          }
          const single = (item: QueueEntry) => item.alone || item.landed !== undefined
          const members = [entry]
          if (!single(entry))
            for (const item of waiting.slice(1)) {
              if (members.length >= size || item.target !== entry.target || single(item)) break
              members.push(item)
            }
          if (members.length === 1) {
            if (!(entry.state === 'landing' && entry.landed))
              await log(tx, runtime.conversationId, entry, { step: 'started' })
            entry.state = 'landing'
            return { status: 'running', checkpoint: { phase: 'land', id: entry.id, attempt: 1 } }
          }
          const batch = `batch-${Date.now().toString(36)}`
          await log(tx, runtime.conversationId, batchLine(batch, members), {
            step: 'started',
            batch: members.map((member) => ({
              submission: member.id,
              conversationId: member.conversationId,
              tip: member.tip,
              ...(member.subject ? { subject: member.subject } : {}),
            })),
          })
          const at = Date.now()
          for (const member of members) {
            member.state = 'landing'
            const others = members.filter((other) => other !== member)
            member.steps.push({
              step: `started with ${others.map((other) => `#${other.conversationId}`).join(', ')}`,
              at,
            })
          }
          return {
            status: 'running',
            checkpoint: {
              phase: 'batch',
              batch,
              ids: members.map((member) => member.id),
              attempt: 1,
            },
          }
        }, context)
      },
      land: async (task, runtime, context) => {
        const { id, attempt, pushRetried } = task.state.checkpoint
        const { signal } = runtime
        const index = (await runtime.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
        const entry = index.queue.find((item) => item.id === id)!
        const recordedFirstFastForward = async () =>
          (await runtime.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!.queue.find(
            (item) => item.id === id,
          )?.landed
        const step = stepper(runtime, context, id, [id])
        const commitLandingOutcome = (text: string, outcome: LanderOutcome) =>
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
        const push = async (settings: Settings, checkedCommit: string) => {
          if (!settings.push) return { text: 'Not pushed.' }
          await step(`pushing to ${settings.push}`)
          try {
            await online(runtime, context, step, source, settings.push)(
              source,
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
        const landedReport = async (
          settings: Settings,
          landed: Landed,
          sha: string,
          pushing = sha,
        ) => {
          const pushed = landed.pushed
            ? { remote: landed.pushed, text: `Pushed to ${landed.pushed}.` }
            : await push(settings, pushing)
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
          )
        }
        try {
          const settings = await landerSettings(host)
          const landedHere =
            entry.landed !== undefined &&
            (await contains(source, entry.landed.sha, `refs/heads/${target}`))
          if (entry.landed && !landedHere)
            await runtime.commit(async (tx) => {
              const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
              delete draft.queue.find((item) => item.id === id)!.landed
            }, context)
          if (landedHere && attempt === 1 && !pushRetried)
            return await landedReport(
              settings,
              entry.landed!,
              entry.landed!.sha,
              entry.landed!.checked ?? entry.landed!.sha,
            )
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
              const fetched = await remoteAhead(
                path,
                settings.push,
                target,
                online(runtime, context, step, source, settings.push),
              )
              if (fetched) {
                await step(`merging ${settings.push}/${target}`)
                const conflicts = await tryMerge(path, fetched, `Merge ${settings.push}/${target}`)
                if (conflicts !== undefined)
                  return await fail(
                    `${settings.push}/${target} conflicts with local ${target} in`,
                    conflicts,
                    `Reconcile ${settings.push}/${target} with local ${target}, then submit again.`,
                  )
              }
              await step('merging')
              const conflicts = await tryMerge(path, entry.tip, mergeMessage(entry))
              if (conflicts !== undefined)
                return await fail(
                  `it conflicts with ${target} in`,
                  conflicts,
                  `Merge ${target} into your workspace, resolve, verify and submit again.`,
                )
              mergedBeforeChecks = await runtime.memo(
                `merged:${id}:${attempt}`,
                { base, sha: await git(path, 'rev-parse', 'HEAD') },
                context,
              )
            }
            const { base } = mergedBeforeChecks
            await step('setting up')
            await setup(source, path, await host.projectSettings(), signal)
            const checked = await runChecks(
              runtime,
              context,
              settings.checks,
              path,
              `${id}:${attempt}`,
              id,
              step,
            )
            if (checked.failed)
              return await fail(
                `check failed twice: ${checked.failed.command}`,
                checked.failed.output,
                'Fix it at its cause (a flaky test too: fix or delete it), verify and submit again.',
              )
            const { flaky } = checked
            if (!(await unchanged(path, mergedBeforeChecks.sha)))
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
          const { moved, refused } = await fastForward(source, target, base, integrated)
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
      batch: async (task, runtime, context) => {
        const { batch, ids, attempt } = task.state.checkpoint
        const { signal } = runtime
        const index = (await runtime.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
        const members = ids.map((id) => index.queue.find((item) => item.id === id)!)
        const { source, target } = members[0]
        const key = `${batch}:${ids.join('+')}:${attempt}`
        const step = stepper(runtime, context, batch, ids)
        const split = async (reason: string, output?: string) => {
          const now = (await runtime.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
          const landedThere = new Set<string>()
          for (const id of ids) {
            const landed = now.queue.find((item) => item.id === id)?.landed
            if (landed && (await contains(source, landed.sha, `refs/heads/${target}`)))
              landedThere.add(id)
          }
          return runtime.commit(async (tx) => {
            const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
            const saved = ids.map((id) => draft.queue.find((item) => item.id === id)!)
            const text = `batch not landed: ${reason}; landing one at a time`
            await log(tx, runtime.conversationId, batchLine(batch, saved), {
              step: text,
              ...(output ? { output } : {}),
            })
            const at = Date.now()
            for (const member of saved) {
              member.steps.push({ step: text, at })
              member.alone = true
              member.state = 'queued'
              delete member.step
              if (!landedThere.has(member.id)) delete member.landed
            }
            return { status: 'running', checkpoint: { phase: 'next' } }
          }, context)
        }
        const drop = (member: QueueEntry, conflicts: string) =>
          runtime.commit(async (tx) => {
            const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
            const saved = ids.map((id) => draft.queue.find((item) => item.id === id)!)
            const text = `#${member.conversationId} conflicts with the batch; it lands by itself after it`
            await log(tx, runtime.conversationId, batchLine(batch, saved), {
              step: text,
              output: conflicts,
            })
            const at = Date.now()
            for (const item of saved) item.steps.push({ step: text, at })
            const dropped = saved.find((item) => item.id === member.id)!
            dropped.alone = true
            dropped.state = 'queued'
            delete dropped.step
            const rest = saved.filter((item) => item.id !== member.id)
            const queue = draft.queue.filter((item) => item.id !== member.id)
            queue.splice(queue.findIndex((item) => item.id === rest.at(-1)!.id) + 1, 0, dropped)
            draft.queue = queue
            if (rest.length > 1)
              return {
                status: 'running',
                checkpoint: { phase: 'batch', batch, ids: rest.map((item) => item.id), attempt },
              }
            await log(tx, runtime.conversationId, rest[0], { step: 'started' })
            return { status: 'running', checkpoint: { phase: 'land', id: rest[0].id, attempt: 1 } }
          }, context)
        try {
          const settings = await landerSettings(host)
          let prepared = await runtime.memo<{ base: string; merges: string[]; flaky: string[] }>(
            `prepared:${key}`,
            context,
          )
          if (!prepared) {
            let merged = await runtime.memo<{ base: string; merges: string[] }>(
              `merged:${key}`,
              context,
            )
            const path = await resetTrackedIntegration(
              source,
              merged?.merges.at(-1) ?? (await git(source, 'rev-parse', `refs/heads/${target}`)),
            )
            if (!merged) {
              await step('preparing')
              const base = await git(path, 'rev-parse', 'HEAD')
              const fetched = await remoteAhead(
                path,
                settings.push,
                target,
                online(runtime, context, step, source, settings.push),
              )
              if (fetched) {
                await step(`merging ${settings.push}/${target}`)
                const conflicts = await tryMerge(path, fetched, `Merge ${settings.push}/${target}`)
                if (conflicts !== undefined)
                  return await split(
                    `${settings.push}/${target} conflicts with local ${target}`,
                    conflicts,
                  )
              }
              const merges: string[] = []
              for (const member of members) {
                await step(`merging #${member.conversationId}`)
                const conflicts = await tryMerge(path, member.tip, mergeMessage(member))
                if (conflicts !== undefined) return await drop(member, conflicts)
                merges.push(await git(path, 'rev-parse', 'HEAD'))
              }
              merged = await runtime.memo(`merged:${key}`, { base, merges }, context)
            }
            const integrated = merged.merges.at(-1)!
            await step('setting up')
            await setup(source, path, await host.projectSettings(), signal)
            const checked = await runChecks(
              runtime,
              context,
              settings.checks,
              path,
              key,
              batch,
              step,
            )
            if (checked.failed)
              return await split(
                `check failed twice: ${checked.failed.command}`,
                checked.failed.output,
              )
            if (!(await unchanged(path, integrated)))
              return await split('the integration checkout changed during checks')
            prepared = await runtime.memo(
              `prepared:${key}`,
              { ...merged, flaky: checked.flaky },
              context,
            )
          }
          const { base, merges, flaky } = prepared
          const integrated = merges.at(-1)!
          const landed: Landed[] = []
          for (const [position, sha] of merges.entries()) {
            const from = position ? merges[position - 1] : base
            const weight = await landingWeight(source, from, sha)
            landed.push({
              sha,
              base: from,
              ...(weight ? { weight } : {}),
              commits: lines(await git(source, 'log', '--oneline', `${from}..${sha}`)),
              paths: lines(await git(source, 'diff', '--name-only', from, sha)),
              flaky,
              checked: integrated,
            })
          }
          await runtime.commit(async (tx) => {
            const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
            for (const [position, id] of ids.entries())
              draft.queue.find((item) => item.id === id)!.landed = landed[position]
          }, context)
          await step('fast-forwarding')
          const { moved, refused } = await fastForward(source, target, base, integrated)
          if (refused)
            return await split(
              `the checkout of ${target} refused the fast-forward to ${integrated.slice(0, 7)}`,
              refused,
            )
          if (moved) {
            if (attempt < maxTargetMoveAttempts)
              return await runtime.commit(async (tx) => {
                const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
                for (const id of ids) delete draft.queue.find((item) => item.id === id)!.landed
                return {
                  status: 'running',
                  checkpoint: { phase: 'batch', batch, ids, attempt: attempt + 1 },
                }
              }, context)
            return await split(`${target} kept moving during ${maxTargetMoveAttempts} attempts`)
          }
          let pushed: string | undefined
          if (settings.push) {
            await step(`pushing to ${settings.push}`)
            try {
              await online(runtime, context, step, source, settings.push)(
                source,
                'push',
                '-q',
                settings.push,
                `${integrated}:refs/heads/${target}`,
              )
              pushed = `${settings.push}/${target}`
            } catch (error) {
              if (signal.aborted) throw error
              await step(`${settings.push} rejected the push; each submission pushes on its own`, {
                output: failure(error),
              })
            }
          }
          await runtime.commit(async (tx) => {
            const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
            for (const id of ids) {
              const saved = draft.queue.find((item) => item.id === id)!
              draft.items[String(saved.conversationId)].landed = saved.landed!.sha
              if (pushed) saved.landed!.pushed = pushed
            }
            return { status: 'running', checkpoint: { phase: 'next' } }
          }, context)
        } catch (error) {
          if (signal.aborted) throw error
          return await split('it failed', failure(error))
        }
      },
      report: async (task, runtime, context) => {
        const { id, conversationId, text, outcome } = task.state.checkpoint
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
          return {
            status: 'running',
            checkpoint: {
              phase: 'deliver',
              id,
              conversationId,
              text,
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
          text,
          outcome,
          concluded: conclusionCommitted,
          starter,
        } = task.state.checkpoint
        const entry = { kind: LanderReportEntry.kind, data: { id, outcome } }
        const content = `${text}\nDiverged: ${outcome.divergence}\n${conclusionCommitted ? `#${conversationId} is concluded.` : `#${conversationId} still has work under way; it reports when it stops.`}`
        if (starter !== undefined)
          await (
            await host.harness().conversation(starter, context)
          )?.submit(
            conclusionCommitted
              ? { type: 'input', content, entry, whenBusy: 'followUp', requestId: `lander:${id}` }
              : {
                  type: 'write',
                  requestId: `lander:${id}`,
                  entry: {
                    ...entry,
                    model: [{ role: 'user', content, timestamp: Date.now() }],
                  },
                },
            context,
          )
        await runtime.commit(
          () => ({
            status: 'running',
            checkpoint: conclusionCommitted
              ? { phase: 'release', conversationId }
              : { phase: 'next' },
          }),
          context,
        )
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
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, context),
  })
  return Lander
}
