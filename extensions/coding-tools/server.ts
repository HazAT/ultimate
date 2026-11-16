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
  type ToolExecutionApi,
  type ToolExecutionResult,
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
import { createNodePhotonImages } from '@earendil-works/pi-durable/images/node'
import { git } from '../../lib/git.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { watchSteer } from '../../lib/steer.ts'
import { CancelAction, CancelledDoc, Committed } from './refs.ts'

const modelSizedImages = await createNodePhotonImages()

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
export const docs = [DurableCancellations]

function took(ms: number) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}m`
}

async function untilStopped(
  run: (context: Context) => Promise<ToolExecutionResult>,
  api: ToolExecutionApi,
  interruptible: boolean | undefined,
  context: Context,
): Promise<ToolExecutionResult> {
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
    const outputWithTrailingNotice = `${retained.text || '(no output)'}\n[${reason} after ${took(performance.now() - started)}; the output above is the last the command printed.]`
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

export default function codingTools(host: Pick<ExtensionHost, 'emit'>) {
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
  })
  const tracedBashTool = defineTool({
    ...shell,
    parameters,
    async execute({ interruptible, ...args }, api, context) {
      const change = interruptible ? changes(args.command) : undefined
      if (change)
        throw new Error(
          `An interruptible command must only wait, but this one changes things (${change}). Run the change in its own bash call, then wait in a separate interruptible one.`,
        )
      const invocationLog = join(tmpdir(), `ultimate-commits-${randomUUID()}.log`)
      const call = createBashTool({
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
    tools: [
      createReadTool({ images: modelSizedImages }),
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
