/**
 * `board.route`: a branch's final answers reach the conversation that started it, and that conversation's final answer
 * to a branch's report or reply reaches the branch.
 */
import { defineTask, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type {
  ConversationId,
  EntryId,
  GenerationResult,
  SubmissionId,
  TaskId,
  Tx,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { Subagents } from '../subagents/api.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { Messages } from './api.ts'
import { isOpen } from '../../lib/message-state.ts'
import { terminal } from './log.ts'
import type { Message } from './api.ts'
import type { Remote } from './refs.ts'
import { send } from './send.ts'
import { tell } from './remote.ts'
import { Started } from './addresses.ts'
import type { Serves } from './addresses.ts'

/** The lander's card in the starter, an input only when the landing concluded the branch (workspaces' lander.ts). */
const LANDED = 'workspaces.lander-report'

/** Every task state but `terminal`: queried by status, so finished tasks are never scanned. */
const LIVE = ['pending', 'running', 'waiting', 'sleeping', 'completing'] as const
/** Live tasks of `kind` in `conversationId` (any conversation when undefined). */
async function live(tx: Tx, kind: string, conversationId?: ConversationId) {
  const found = []
  for (const status of LIVE) {
    let cursor: Parameters<Tx['scanTasks']>[2]
    do {
      const page = await tx.scanTasks(
        { ...(conversationId === undefined ? {} : { conversationId }), kind, status },
        100,
        cursor,
      )
      found.push(...page.items)
      cursor = page.next
    } while (cursor !== undefined)
  }
  return found
}
/**
 * Whether `id` runs or has input queued, or one of its tasks will wake it: a subagent's report until its input is
 * admitted, or a waking `notify` on another conversation. Matched by kind, so messages needs neither extension.
 */
async function busy(tx: Tx, id: ConversationId) {
  if ((await tx.doc(LiveDoc, id)).run || (await tx.doc(InboxDoc, id)).items.length) return true
  if ((await live(tx, 'ultimate.subagent-reporter', id)).length) return true
  return (await live(tx, 'lineage.notify', id)).some(
    (task) => (task.input as { wake?: unknown }).wake !== false,
  )
}
/**
 * Whether branch `id` still has work under way that will wake it again: a run or queued input, a waking task, a
 * subagent at any depth that is busy, a submission the lander has not reported yet, or a reply-enabled message still
 * waiting on its answer. While the lander reports a landing it decides, once, whether the branch is done: it
 * concludes it and wakes the starter, or leaves it open to report when it stops. Until then a report waits as a note.
 */
async function underway(host: ExtensionHost, tx: Tx, id: ConversationId): Promise<boolean> {
  // A landing concludes the branch in the commit that ends its report and wakes the starter itself; an answer routed
  // after that, or for a branch concluded by hand, is not a report. Any input that runs the branch resumes it first.
  if ((await host.need(ConversationsApi).concludedIn(tx)).has(id)) return true
  const queue = (await tx.doc(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID)).queue
  if (queue.some((item) => item.conversationId === id)) return true
  // A submission leaves the queue in the commit that moves the lander to reporting it.
  for (const task of await live(tx, 'workspaces.lander')) {
    const checkpoint = (task.state as { checkpoint?: { phase?: string; conversationId?: number } })
      .checkpoint
    if (checkpoint?.phase === 'report' && checkpoint.conversationId === id) return true
  }
  return working(tx, id)
}
/**
 * Whether `id` has work of its own that will wake it: a run or queued input, a waking task, a busy subagent at any
 * depth, or a reply-enabled message it sent still waiting on its answer. The lander asks it before concluding.
 */
export async function working(tx: Tx, id: ConversationId): Promise<boolean> {
  if (await busy(tx, id)) return true
  const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
  if (log.messages.some((m) => m.from === id && isOpen(m))) return true
  return children(tx, id)
}
async function children(tx: Tx, id: ConversationId): Promise<boolean> {
  for (const child of Object.values((await tx.doc(Subagents, id)).agents))
    if ((await busy(tx, child.conversationId)) || (await children(tx, child.conversationId)))
      return true
  return false
}

/**
 * Where the starter's final answer to its run `answered` goes, when every input was a branch's report or reply, or the
 * card of its landing: to each branch that is not concluded and that the starter did not message during the run, and,
 * for a concluded branch that serves an agent's request (`Started.serves`), to that agent, unless the run messaged it.
 * Replies arriving close together share one run (a reply steers a busy starter), so every branch in it hears the
 * answer, or one of them would wait on it forever. An echo (a branch's answer to a routed answer) routes nowhere, so
 * routing goes back and forth at most once; any other input (the user's) leaves the answer local.
 */
async function reported(host: ExtensionHost, tx: Tx, starter: number, answered: number[]) {
  const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
  // Each branch with the newest message of it the run answers: the starter's messages after it are the run's own.
  const latest = new Map<number, number>()
  for (const entryId of answered) {
    const entry = await tx.entry(entryId as never)
    const data = entry?.data as
      | { id?: unknown; from?: unknown; reply?: unknown; echo?: unknown }
      | undefined
    if (entry?.kind === LANDED) {
      // A landing card is an input only when the landing concluded the branch, which is when its result is ready.
      const results = (await tx.doc(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID)).results
      const branch = results[String(data?.id)]?.conversationId
      if (branch === undefined || (await tx.doc(Started, branch as ConversationId)).by !== starter)
        return { branches: [], askers: [] }
      const last = log.messages.findLast((m) => m.from === branch && m.to === starter)?.id ?? 0
      latest.set(branch, Math.max(latest.get(branch) ?? 0, last))
      continue
    }
    const report =
      entry?.kind === 'board.reply' || (entry?.kind === 'board.message' && data?.reply === false)
    if (!report || typeof data?.from !== 'number') return { branches: [], askers: [] }
    if (data.echo === true) continue
    if ((await tx.doc(Started, data.from as ConversationId)).by !== starter)
      return { branches: [], askers: [] }
    latest.set(data.from, Math.max(latest.get(data.from) ?? 0, Number(data.id ?? 0)))
  }
  const concluded = await host.need(ConversationsApi).concludedIn(tx)
  const messaged = (since: number, to: (m: Message) => boolean) =>
    log.messages.some((m) => m.from === starter && m.id > since && to(m))
  const branches: number[] = []
  const askers: { branch: number; serves: Serves }[] = []
  for (const [branch, since] of latest) {
    if (!concluded.has(branch as ConversationId)) {
      if (!messaged(since, (m) => m.to === branch)) branches.push(branch)
      continue
    }
    // A copy: the doc's proxy is unusable once this commit settles, and `board.route` sends after it.
    const stored = (await tx.doc(Started, branch as ConversationId)).serves
    const serves: Serves | undefined = stored && {
      message: stored.message,
      from: stored.from,
      ...(stored.remote ? { remote: { ...stored.remote } } : {}),
    }
    if (
      serves &&
      // The early answer to the request itself ("started #X") may be logged after a quick branch's reply: not a result.
      !messaged(
        since,
        (m) =>
          m.re !== serves.message &&
          (serves.from === 'remote'
            ? m.to === 'remote' && m.remote?.project === serves.remote!.project
            : m.to === serves.from),
      )
    )
      askers.push({ branch, serves })
  }
  return { branches, askers }
}

/** One message `board.route` sends, with `send`'s options; `remote` sends it to another project's Ultimate. */
interface Route {
  to: number | 'remote'
  remote?: Remote
  text: string
  requestId: string
  options: { note?: boolean; report?: boolean; echo?: boolean; routed?: EntryId }
}

/**
 * After a branch's run, its final answer reaches the conversation that started it, unless it already goes back as the
 * answer to a reply-enabled message, the starter's or another conversation's. A branch that stops with nothing under way reports: its answer wakes
 * the starter. One that still waits on work (subagents, the lander, a reply) leaves it as a note. With `down`, after a
 * run of the starter, its final answer to one branch's report or reply goes to that branch and wakes it (`reported`).
 * Each routed message is one-way, and an answer to a routed answer is an echo that routes no further: no ping-pong.
 */
export function route(host: ExtensionHost) {
  return defineTask<
    {
      generation: TaskId<GenerationResult>
      inputs: SubmissionId[]
      by: number
      /** The starter's own run: route its answer down to the branch it answers. */
      down?: boolean
    },
    { phase: 'observe' },
    null
  >({
    name: 'board.route',
    version: 1,
    initial: () => ({ phase: 'observe' }),
    phases: {
      observe: async (task, runtime, ctx) => {
        const settled = await runtime.waitForTask(task.input.generation, ctx)
        if (settled.state.outcome.status !== 'completed') {
          await runtime.commit(() => terminal, ctx)
          return
        }
        const answer = settled.state.outcome.result.entryId
        const inputs = await Promise.all(
          task.input.inputs.map(async (id) =>
            (await host.harness().submission(id, ctx))?.status(ctx),
          ),
        )
        const { by } = task.input
        const id = runtime.conversationId
        const routed = await host.harness().commit(async (tx): Promise<Route[]> => {
          // A continued generation's answer is no run's final answer: only inputs it settled make one.
          const answered = inputs.flatMap((input) =>
            input?.type === 'input' && input.status === 'done' && input.answer === answer
              ? [input.entry]
              : [],
          )
          if (!answered.length) return []
          const message = (await tx.entry(answer))?.model?.[0]
          if (
            message?.role !== 'assistant' ||
            message.stopReason === 'error' ||
            message.stopReason === 'aborted'
          )
            return []
          const text = message.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
          if (task.input.down) {
            if (!text.trim()) return []
            const { branches, askers } = await reported(host, tx, by, answered)
            const together =
              branches.length > 1
                ? `(This answers ${branches.map((b) => `#${b}`).join(' and ')} together.)\n\n`
                : ''
            return [
              ...branches.map((to) => ({
                to,
                text: together + text,
                requestId: `route:${answer}:${to}`,
                options: { routed: answer },
              })),
              ...askers.map(({ branch, serves }) => ({
                to: serves.from,
                ...(serves.remote ? { remote: serves.remote } : {}),
                text: `Result of #${branch}, which worked on your message ${serves.message}:\n\n${text}`,
                requestId: `route:${answer}:asker:${branch}`,
                options: { routed: answer },
              })),
            ]
          }
          // board.delivery returns an answer to a reply-enabled message to whoever sent it. To the starter's, that is
          // where the answer goes; when every input was another conversation's question (a sibling's, a subagent's),
          // it goes back to them, not also to the starter.
          let elsewhere = true
          // An answer to the starter's routed answers only is an echo: the starter's answer to it stays local.
          let echo = true
          for (const entryId of answered) {
            const entry = await tx.entry(entryId)
            const data = entry?.data as
              | { from?: unknown; reply?: unknown; routed?: unknown }
              | undefined
            const asked =
              entry?.kind === 'board.message' && data?.reply === true && data.from !== 'user'
            if (asked && data.from === by) return []
            if (!asked) elsewhere = false
            if (data?.routed !== true) echo = false
          }
          const report = !(await underway(host, tx, id))
          const up = (body: string, options: Route['options']) => [
            {
              to: by,
              text: body,
              requestId: `route:${answer}`,
              options: { note: !report, report, ...options },
            },
          ]
          if (elsewhere) {
            if (!report) return []
            // Answering them ended the branch's work, though, and the starter may have had its last update only as a
            // note: it becomes the report, so the starter still wakes when the branch stops.
            const last = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.findLast(
              (m) => (m.from === id && m.to === by) || (m.from === by && m.to === id),
            )
            if (last?.from !== id || last.reply || last.report || last.re !== undefined) return []
            return up(last.text, {})
          }
          return up(text, { echo })
        }, ctx)
        for (const { to, remote, text, requestId, options } of routed) {
          if (!text.trim()) continue
          if (to === 'remote') {
            await tell(
              host,
              id,
              { project: remote!.project, machine: remote!.machine, text, reply: false },
              ctx,
              undefined,
              { key: requestId, routed: options.routed! },
            ).catch((error: unknown) => {
              // tell already marked the message failed in the log, where the user sees it; a retry would not reach
              // an Ultimate that is down either, and the route must still finish.
              void error
            })
            continue
          }
          await send(host, id, { to: `#${to}`, text, reply: false }, ctx, {
            requestId,
            ...options,
          })
        }
        await runtime.commit(() => terminal, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
}
