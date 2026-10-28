import {
  AssistantEntry,
  AgentDoc,
  defineTask,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { SubagentsApi } from '../subagents/api.ts'
import { discoverAgents, hostDefaultModel } from '../../lib/agents.ts'
import { nextAt } from './schedule.ts'
import type { Automation, Run } from './types.ts'
import { RUN_TASK } from './types.ts'
import type { Automations as Ledger } from './server.ts'
import { Escalated, Fired } from './refs.ts'
import { RunLabel } from './types.ts'
const owner = {
  ownership: { kind: 'conversation' as const },
  conversationId: ROOT_CONVERSATION_ID,
  background: true,
}
const terminal = {
  status: 'terminal' as const,
  outcome: { status: 'completed' as const, result: null },
}
async function definition(host: ExtensionHost, name: string) {
  const found = (
    await discoverAgents(host.ultimateRoot, host.projectRoot, host.userHome, host.modelRuntime)
  ).definitions.find((d) => d.name === name)
  if (!found) throw new Error(`Unknown agent: ${name}`)
  return found
}
export function scheduler(
  host: ExtensionHost,
  Automations: typeof Ledger,
  deliver: (
    tx: Tx,
    a: Automation,
    event: number | string,
    kind: 'fired' | 'escalated',
    text: string,
  ) => Promise<void>,
) {
  const RunTask = defineTask<
    { automation: Automation; firedAt: number; text?: string },
    { phase: 'create' } | { phase: 'deliver'; conversationId: ConversationId },
    null
  >({
    name: RUN_TASK,
    version: 1,
    initial: () => ({ phase: 'create' }),
    phases: {
      create: async (task, runtime, context) => {
        try {
          const a = task.input.automation
          if (!host.extensions().some((e) => e.name === 'subagents' && e.enabled))
            throw new Error('automations needs the subagents extension enabled')
          // The root's agent for its tools, on the default model: the root's stored model may have lost its login.
          const parent = { ...(await runtime.agent(context)), model: await hostDefaultModel(host) }
          const profile = a.agent ? await definition(host, a.agent) : undefined
          await runtime.commit(async (tx) => {
            const child = await host.need(SubagentsApi).createChild(tx, {
              owner: { kind: 'task', taskId: task.id },
              definition: profile,
              parentAgent: parent,
              modelRuntime: host.modelRuntime,
              metadata: host.metadata,
              label: RunLabel,
              title: `${a.name} · ${new Date(task.input.firedAt).toLocaleString()}`,
              excludeTools: a.agent ? ['automation', 'subagent'] : ['automation'],
              excludeExtensions: ['automations'],
              cwd: (await tx.doc(AgentDoc, runtime.conversationId)).cwd ?? host.projectRoot,
              model: a.model,
              thinking: a.thinking,
            })
            const run = (await tx.doc(Automations)).automations[a.id]?.runs.find(
              (r) => r.id === String(task.id),
            )
            if (run) run.conversationId = child.id
            return { status: 'running', checkpoint: { phase: 'deliver', conversationId: child.id } }
          }, context)
        } catch (error) {
          if (runtime.signal.aborted) throw error
          await runtime.commit(async (tx) => {
            finish(
              await tx.doc(Automations),
              task.input.automation.id,
              String(task.id),
              'failed',
              String(error),
            )
            return terminal
          }, context)
        }
      },
      deliver: async (task, runtime, context) => {
        try {
          const child = (await runtime.conversation(task.state.checkpoint.conversationId, context))!
          const result = await (
            await child.submit(
              {
                type: 'input',
                content:
                  task.input.automation.prompt! +
                  (task.input.text ? `\n\nFired: ${task.input.text}` : ''),
                requestId: `automation-run:${task.id}`,
              },
              context,
            )
          ).wait(context)
          await runtime.commit(async (tx) => {
            const entry =
              result.status === 'done' && result.type === 'input'
                ? await tx.entry(AssistantEntry, result.answer)
                : undefined
            const answer = entry?.model?.[0]
            const text =
              answer?.role === 'assistant'
                ? answer.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
                : undefined
            finish(
              await tx.doc(Automations),
              task.input.automation.id,
              String(task.id),
              result.status === 'done'
                ? 'done'
                : result.status === 'unanswered' && result.reason === 'aborted'
                  ? 'aborted'
                  : 'failed',
              text,
            )
            return terminal
          }, context)
        } catch (error) {
          if (runtime.signal.aborted) throw error
          await runtime.commit(async (tx) => {
            finish(
              await tx.doc(Automations),
              task.input.automation.id,
              String(task.id),
              'failed',
              String(error),
            )
            return terminal
          }, context)
        }
      },
    },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        finish(await tx.doc(Automations), task.input.automation.id, String(task.id), 'aborted')
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, context),
  })
  async function fire(tx: Tx, a: Automation, firedAt: number, text = '') {
    a.recentFires = (a.recentFires ?? []).filter((at) => at > firedAt - 3600000)
    if (a.recentFires.length >= 6) {
      const reason = 'Fired more than 6 times in an hour; paused'
      a.enabled = false
      delete a.nextAt
      if (a.script) {
        a.script.state = 'stopped'
        a.script.error = reason
      }
      const event = await host.emit(tx, Escalated, { id: a.id, reason })
      await deliver(tx, a, event.id, 'escalated', reason)
      return { id: a.id }
    }
    // Scan for overlapping runs before any task/entry writes in this transaction.
    const result = a.prompt ? await fireRun(tx, a, firedAt, text) : { id: a.id }
    a.recentFires.push(firedAt)
    a.fires++
    a.lastFireAt = firedAt
    const event = await host.emit(tx, Fired, { id: a.id, text, fire: a.fires })
    if (a.subscribers.length) await deliver(tx, a, event.id, 'fired', text)
    return result
  }
  const activeRuns = new WeakMap<Tx, Set<string>>()
  // One event can fire several automations. Read their overlaps before the first fire writes any entries/tasks.
  async function prepareFires(tx: Tx): Promise<Set<string>> {
    const cached = activeRuns.get(tx)
    if (cached) return cached
    const ids = new Set<string>()
    // A long run can outlive the bounded run history.
    for (const status of ['pending', 'running', 'waiting', 'completing'] as const) {
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanTasks(
          { conversationId: ROOT_CONVERSATION_ID, kind: RUN_TASK, status },
          100,
          cursor,
        )
        for (const task of page.items)
          ids.add((task.input as { automation: Automation }).automation.id)
        cursor = page.next
      } while (cursor)
    }
    activeRuns.set(tx, ids)
    return ids
  }
  async function fireRun(tx: Tx, a: Automation, firedAt: number, text: string) {
    const running = a.runs.some((r) => r.status === 'running') || (await prepareFires(tx)).has(a.id)
    if (running) {
      a.runs.push({ id: `skipped:${firedAt}`, firedAt, finishedAt: firedAt, status: 'skipped' })
    } else {
      const id = await tx.createTask(
        RunTask,
        {
          automation: { ...(JSON.parse(JSON.stringify(a)) as Automation), runs: [] },
          firedAt,
          text,
        },
        owner,
      )
      activeRuns.get(tx)!.add(a.id)
      a.runs.push({ id: String(id), firedAt, status: 'running' })
    }
    a.runs = a.runs.slice(-50)
    return a.runs.at(-1)!
  }
  const Scheduler = defineTask<
    { id: string },
    { phase: 'plan' } | { phase: 'sleep'; until: number } | { phase: 'fire'; until: number },
    null
  >({
    name: 'ultimate.automation-scheduler',
    version: 1,
    initial: () => ({ phase: 'plan' }),
    phases: {
      plan: (task, runtime, context) =>
        runtime.commit(async (tx) => {
          const a = (await tx.doc(Automations)).automations[task.input.id]
          if (!a?.enabled || a.scheduler !== task.id) return terminal
          const until =
            a.nextAt ??
            nextAt(
              a.schedule!,
              Math.max(runtime.now(), a.lastFireAt ?? a.createdAt),
              a.lastFireAt ?? a.createdAt,
            )
          a.nextAt = until
          return { status: 'running', checkpoint: { phase: 'sleep', until } }
        }, context),
      sleep: (task, runtime, context) =>
        runtime.sleepUntil(
          task.state.checkpoint.until,
          { phase: 'fire', until: task.state.checkpoint.until },
          context,
        ),
      fire: (task, runtime, context) =>
        runtime.commit(async (tx) => {
          const a = (await tx.doc(Automations)).automations[task.input.id]
          if (!a?.enabled || a.scheduler !== task.id) return terminal
          await fire(tx, a, runtime.now())
          delete a.nextAt
          if (!a.enabled || a.schedule!.kind === 'at') {
            a.enabled = false
            delete a.scheduler
            return terminal
          }
          return { status: 'running', checkpoint: { phase: 'plan' } }
        }, context),
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  })

  return { RunTask, Scheduler, fire, prepareFires }
}
function finish(
  state: { automations: Record<string, Automation> },
  id: string,
  runId: string,
  status: Run['status'],
  answer?: string,
) {
  const run = state.automations[id]?.runs.find((r) => r.id === runId)
  if (run) {
    run.status = status
    run.finishedAt = Date.now()
    if (answer !== undefined) run.answer = answer.trim().split('\n')[0].slice(0, 200)
  }
}
