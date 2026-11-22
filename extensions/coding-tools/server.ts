import type { ConversationId } from '@earendil-works/pi-durable'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context'
import { bool, num, obj, opt, str } from '@earendil-works/pi-schema'
import {
  defineDoc,
  defineExtension,
  defineTool,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolPark,
  type ToolRegistration,
  wrapTool,
} from '@earendil-works/pi-durable'
import {
  type BashExecution,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-durable/tools'
import { formatDuration } from '../../lib/format.ts'
import { git } from '../../lib/git.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { watchSteer } from '../../lib/steer.ts'
import { BackgroundStarted, CancelAction, CancelledDoc, Committed } from './refs.ts'
import { Concluded, ConversationsApi } from '../conversations/api.ts'
import { defineEffect } from '../../lib/effect.ts'
import {
  BackgroundGroups,
  dropHostNodeEnv,
  recordStarted,
  startBackground,
  type Started,
  stopStarted,
  sweepEarlierProcesses,
  takeStarted,
} from './background.ts'

function defaultBashTimeout() {
  const seconds = Number(process.env.ULTIMATE_BASH_TIMEOUT ?? 600)
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error('ULTIMATE_BASH_TIMEOUT must be a positive finite number of seconds')
  return seconds
}

const bashTripwireMessage = (seconds: number) =>
  `Tripwire: bash ran past the ${seconds} s default limit and was stopped. Pass timeout for longer commands.`

const hookRepoFields = `"$(git symbolic-ref -q --short HEAD)" "$(git rev-parse --show-toplevel)" "$(git rev-parse --path-format=absolute --git-common-dir)"`
const logCommit = `printf 'commit\\t%s\\t%s\\t%s\\t%s\\n' "$(git rev-parse HEAD)" ${hookRepoFields} 2>/dev/null >> "$ULTIMATE_COMMIT_LOG" || true #`
const nonBlockingGitHooks = (conversation: ConversationId) => ({
  'prepare-commit-msg': `git interpret-trailers --in-place --if-exists doNothing --trailer "Ultimate-Conversation: ${conversation}" "$1" #`,
  'post-commit': logCommit,
  'post-applypatch': logCommit,
  'post-merge': `printf 'merge\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$(git rev-parse HEAD)" ${hookRepoFields} "$(git rev-parse -q --verify ORIG_HEAD)" "$(git reflog -1 --format=%gs)" 2>/dev/null >> "$ULTIMATE_COMMIT_LOG" || true #`,
  'post-rewrite': `while read -r old new rest; do printf 'rewrite\\t%s\\t\\t\\t%s\\t%s\\n' "$new" "$(git rev-parse --path-format=absolute --git-common-dir)" "$old"; done 2>/dev/null >> "$ULTIMATE_COMMIT_LOG" || true #`,
})

export async function prepareBash(
  execution: BashExecution,
  api: Pick<ToolExecutionApi, 'conversationId'>,
  log?: string,
) {
  const worktree = await git(execution.cwd, 'rev-parse', '--show-toplevel').catch(() => '')
  if (!worktree.trim()) return
  execution.env.ULTIMATE_COMMIT_WORKTREE = worktree.trim()
  let count = Number(process.env.GIT_CONFIG_COUNT ?? 0)
  for (const [event, command] of Object.entries(nonBlockingGitHooks(api.conversationId))) {
    execution.env[`GIT_CONFIG_KEY_${count}`] = `hook.ultimate-${event}.event`
    execution.env[`GIT_CONFIG_VALUE_${count++}`] = event
    execution.env[`GIT_CONFIG_KEY_${count}`] = `hook.ultimate-${event}.command`
    execution.env[`GIT_CONFIG_VALUE_${count++}`] =
      `[ "$(git rev-parse --show-toplevel 2>/dev/null)" = "$ULTIMATE_COMMIT_WORKTREE" ] || exit 0; ${command}`
  }
  execution.env.GIT_CONFIG_COUNT = String(count)
  if (log) execution.env.ULTIMATE_COMMIT_LOG = log
}

export function changes(command: string) {
  const joinedBashLines = command.replaceAll('\\\n', ' ')
  const end = '(?=$|[\\s;&|)])'
  return (
    new RegExp(`\\bgit\\s+(?:-C\\s+\\S+\\s+|-\\S+\\s+)*(push|commit|merge)${end}`).exec(
      joinedBashLines,
    )?.[1] ??
    new RegExp(`(?:^|[\\s;&|(])(install|migrate)(?=$|[\\s;&|):])`).exec(joinedBashLines)?.[1]
  )
}

const DurableCancellations = defineDoc<{ calls: Record<string, number> }>({
  kind: CancelledDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ calls: {} }),
})
export const docs = [DurableCancellations, BackgroundGroups]

async function untilStopped(
  run: (context: Context) => Promise<ToolExecutionResult | ToolPark>,
  api: ToolExecutionApi,
  interruptible: boolean | undefined,
  context: Context,
): Promise<ToolExecutionResult | ToolPark> {
  const id = api.conversationId
  const cancellationDoc = await api.snapshot(DurableCancellations, id, context)
  if (!cancellationDoc) await api.commit((tx) => tx.doc(DurableCancellations, id), context)
  const cancelled = (await api.watchDoc(DurableCancellations, id, context))!
  const started = performance.now()
  const { context: command, cancel } = withCancel(context)
  let reason: string | undefined
  const stop = (why: string) => {
    if (reason) return
    reason = why
    cancel(new Error(why))
  }
  const inspectCancelled = (value: typeof cancelled.value) => {
    if (value?.calls[api.callId] !== undefined) stop('Cancelled by the user')
  }
  cancelled.start(async (call) => {
    if (call.kind === 'value') inspectCancelled(call.value)
  })
  const stopSteer = interruptible
    ? await watchSteer(api, context, () => stop('Interrupted by a steering message'))
    : undefined
  try {
    inspectCancelled(cancelled.value)
    return await run(command)
  } catch (error) {
    if (!reason || context.abortSignal?.aborted) throw error
    const retained = api.retainedOutput()
    const outputWithTrailingNotice = `${retained.text || '(no output)'}\n[${reason} after ${formatDuration(performance.now() - started)}; the output above is the last the command printed.]`
    return {
      output: [
        {
          type: 'text',
          text: outputWithTrailingNotice,
        },
      ],
      structuredOutput: { output: retained.text, truncated: retained.truncated, exitCode: 130 },
    }
  } finally {
    await Promise.all([cancelled.stop(), stopSteer?.()])
  }
}

export const userActions = ['cancel']
export const actions = {
  cancel: implementAction(CancelAction, async (args, { host, conversationId }) => {
    const callId =
      args && typeof args === 'object' && !Array.isArray(args) ? args.callId : undefined
    if (typeof callId !== 'string' || conversationId === undefined)
      throw new Error('Invalid bash call')
    const id = conversationId
    await host.harness().commit(async (tx) => {
      const live = await tx.doc(LiveDoc, id)
      const running = new Set(
        [...(live.tools ?? []), ...(live.nestedTools ?? [])].flatMap((slot) =>
          slot.name === 'bash' && slot.status === 'running' ? [slot.callId] : [],
        ),
      )
      if (!running.has(callId)) throw new Error('That bash call is not running')
      const calls = (await tx.doc(DurableCancellations, id)).calls
      for (const ended of Object.keys(calls)) if (!running.has(ended)) delete calls[ended]
      calls[callId] = Date.now()
    }, BACKGROUND_CONTEXT)
    return null
  }),
}

type Made = {
  sha: string
  branch?: string
  toplevel: string
  common: string
  rewrittenFrom?: string
}

async function madeCommits(path: string, conversation: ConversationId) {
  const log = await readFile(path, 'utf8').catch(() => '')
  await rm(path, { force: true })
  const made = new Map<string, Made>()
  const merges = new Map<string, string>()
  const rewrites: string[][] = []
  for (const line of log.split('\n')) {
    const [kind, sha, branch, toplevel, common, extra, reflog] = line.split('\t')
    if (!sha || !common) continue
    if (kind === 'rewrite') rewrites.push([sha, extra])
    else if (kind === 'merge' && reflog?.endsWith(': Fast-forward')) continue
    else if ((kind === 'commit' || kind === 'merge') && !made.has(sha)) {
      made.set(sha, { sha, ...(branch ? { branch } : {}), toplevel, common })
      if (kind === 'merge') merges.set(sha, extra ?? '')
    }
  }
  for (const [sha, old] of rewrites) {
    const commit = made.get(sha)
    if (commit && old) commit.rewrittenFrom = old
  }
  const byRepo = Map.groupBy(made.values(), (commit) => commit.common)
  const events = []
  for (const [sharedGitDir, commits] of byRepo) {
    const shown = await git(
      sharedGitDir,
      'log',
      '--no-walk=unsorted',
      '--format=%H%x00%P%x00%s%x1e',
      ...commits.map((commit) => commit.sha),
    ).catch(() => '')
    const details = new Map(
      shown
        .split('\x1e')
        .map((record) => record.trim().split('\0'))
        .map(([sha, parents, subject]) => [sha, { parents, subject }]),
    )
    for (const commit of commits) {
      const found = details.get(commit.sha)
      if (!found) continue
      const parents = found.parents ? found.parents.split(' ') : []
      const headBeforeMerge = merges.get(commit.sha)
      const notOwnMergeCommit =
        headBeforeMerge !== undefined && !(parents.length > 1 && parents[0] === headBeforeMerge)
      if (notOwnMergeCommit) continue
      const repo = basename(sharedGitDir) === '.git' ? dirname(sharedGitDir) : sharedGitDir
      events.push({
        conversation,
        sha: commit.sha,
        parents,
        repo,
        ...(commit.toplevel && commit.toplevel !== repo ? { worktree: commit.toplevel } : {}),
        ...(commit.branch ? { branch: commit.branch } : {}),
        subject: found.subject,
        ...(commit.rewrittenFrom ? { rewrittenFrom: commit.rewrittenFrom } : {}),
      })
    }
  }
  return events
}

export default function codingTools(
  host: Pick<ExtensionHost, 'emit' | 'home' | 'images' | 'need' | 'notice' | 'onOpen' | 'react'>,
) {
  host.onOpen(() =>
    sweepEarlierProcesses(host.home).catch((error: unknown) =>
      host.notice(`Stopping background processes an earlier Ultimate left: ${String(error)}`),
    ),
  )
  const StopBackground = defineEffect<{ groups: Started[] }, null>(
    'coding-tools.stop-background',
    async ({ groups }) => {
      await stopStarted(host.home, groups)
      return null
    },
    async (_tx, { groups }, outcome) => {
      if (!outcome.ok)
        host.notice(
          `Stopping background processes of #${[...new Set(groups.map((group) => group.conversation))].join(', #')} failed: ${outcome.error}`,
        )
    },
  )
  host.react('stop-background', [BackgroundStarted, Concluded], async (tx, event) => {
    if (BackgroundStarted.is(event)) return recordStarted(tx, event.data)
    if (!Concluded.is(event)) return
    const groups = await takeStarted(tx, event.data.conversations)
    if (!groups.length) return
    await tx.createTask(
      StopBackground,
      { groups },
      {
        conversationId: ROOT_CONVERSATION_ID,
        ownership: { kind: 'conversation' },
        background: true,
      },
    )
  })
  const shell = createBashTool()
  const parameters = obj({
    command: str({ description: 'Bash command to execute' }),
    timeout: opt(
      num({
        description:
          'Timeout in seconds (optional; without it a default tripwire, 600 s unless configured, stops the command)',
      }),
    ),
    interruptible: opt(
      bool({
        description:
          'Only for commands that just wait or poll (CI checks, deploys, a file appearing): a steering message ends the command early. Never combine with commands that change things.',
      }),
    ),
    background: opt(
      bool({
        description:
          'For servers and other long-running processes: start the command in its own process group and return at once with the group id, a log file of its output and the command that stops it. Do not add & yourself. Ultimate stops it when this conversation concludes or Ultimate restarts.',
      }),
    ),
  })
  const tracedBashTool = defineTool({
    ...shell,
    parameters,
    async execute({ interruptible, background, ...args }, api, context) {
      if (background) {
        if (!api.env) throw new Error('No execution environment is configured')
        const { pgid, log, started, stop } = await startBackground(
          host,
          api.conversationId,
          api.env.cwd,
          args.command,
          context.abortSignal,
        )
        const conversations = host.need(ConversationsApi)
        const concluded = await api
          .commit(async (tx) => {
            const ended = await conversations.concludedIn(tx)
            for (let id: ConversationId | undefined = api.conversationId; id !== undefined;) {
              if (ended.has(id)) return true
              id = (await tx.conversation(id))?.owner?.conversationId
            }
            await host.emit(tx, BackgroundStarted, started)
            return false
          }, context)
          .catch(async (error: unknown) => {
            await stop()
            throw error
          })
        if (concluded) {
          await stop()
          throw new Error('This conversation is concluded; its background processes are stopped')
        }
        const output = `Started in the background as process group ${pgid}.\nOutput: ${log}\nStop it with: kill -- -${pgid}`
        return {
          output: [{ type: 'text', text: output }],
          structuredOutput: { output, truncated: false, exitCode: 0 },
        }
      }
      const change = interruptible ? changes(args.command) : undefined
      if (change)
        throw new Error(
          `An interruptible command must only wait, but this one changes things (${change}). Run the change in its own bash call, then wait in a separate interruptible one.`,
        )
      const invocationLog = join(tmpdir(), `ultimate-commits-${randomUUID()}.log`)
      const call = createBashTool({
        commandPrefix: dropHostNodeEnv,
        prepare: (execution) => prepareBash(execution, api, invocationLog),
      })
      const run = (command: Context) => call.execute(args, api, command)
      try {
        return await untilStopped(run, api, interruptible, context)
      } finally {
        const advisoryCommits = await madeCommits(invocationLog, api.conversationId)
        if (advisoryCommits.length)
          await api
            .commit(async (tx) => {
              for (const commit of advisoryCommits) await host.emit(tx, Committed, commit)
            }, context)
            .catch((error: unknown) =>
              console.error('coding-tools: recording commits failed:', error),
            )
      }
    },
  })
  return defineExtension({
    name: 'coding-tools',
    tasks: [StopBackground],
    tools: [
      createReadTool({ images: host.images }),
      createWriteTool(),
      createEditTool(),
      tracedBashTool,
    ] as ToolRegistration[],
    wraps: [
      wrapTool(createBashTool(), (bash) => ({
        ...bash,
        async execute(args, api, context) {
          if (args.timeout !== undefined) return bash.execute(args, api, context)
          const timeout = defaultBashTimeout()
          try {
            return await bash.execute({ ...args, timeout }, api, context)
          } catch (error) {
            if (
              error instanceof Error &&
              /^Command timed out after [\d.e+-]+ seconds$/.test(error.message)
            )
              throw new Error(bashTripwireMessage(timeout), { cause: error })
            throw error
          }
        },
      })),
    ],
  })
}
