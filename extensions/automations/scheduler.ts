import {
  AssistantEntry,
  AgentDoc,
  defineTask,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { SubagentsApi } from '../subagents/api.ts'
import { MessagesApi } from '../messages/api.ts'
import { discoverAgents, hostDefault } from '../../lib/agents.ts'
import { nextAt } from './schedule.ts'
import type { Automation, Run } from './types.ts'
import { RUN_TASK } from './types.ts'
import { settledSubmission, submitAndSleep } from '../../lib/settled.ts'
import type { Automations as Ledger } from './server.ts'
import { Escalated, Fired } from './refs.ts'
import { Hold } from './api.ts'
import { RunLabel } from './types.ts'
const MAX_FIRES_PER_HOUR = 6
const FIRE_WINDOW_MS = 3600000
const RETAINED_RUNS = 50
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
    kind: 'fired' | 'escalated' | 'finished',
    text: string,
  ) => Promise<void>,
) {
  const RunTask = defineTask<
    { automation: Automation; firedAt: number; text?: string },
    { phase: 'create' } | { phase: 'deliver' | 'settled'; conversationId: ConversationId },
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
          const rootToolsOnDefaultModel = {
            ...(await runtime.agent(context)),
            ...(await hostDefault(host)),
          }
          const profile = a.agent ? await definition(host, a.agent) : undefined
          await runtime.commit(async (tx) => {
            const child = await host.need(SubagentsApi).createChild(tx, {
              owner: { kind: 'task', taskId: task.id },
              definition: profile,
              parentAgent: rootToolsOnDefaultModel,
              modelRuntime: host.modelRuntime,
              metadata: host.metadata,
              label: RunLabel,
              title: `${a.name} · ${new Date(task.input.firedAt).toLocaleString()}`,
              excludeTools:
                profile && !profile.tools?.includes('subagent')
                  ? ['automation', 'subagent']
                  : ['automation'],
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
            await settle(tx, task.input.automation.id, String(task.id), 'failed', String(error))
            return terminal
          }, context)
        }
      },
      deliver: async (task, runtime, context) => {
        try {
          const { conversationId } = task.state.checkpoint
          await submitAndSleep(
            runtime,
            (await runtime.conversation(conversationId, context))!,
            {
              type: 'input',
              content:
                task.input.automation.prompt! +
                (task.input.text ? `\n\nFired: ${task.input.text}` : ''),
              requestId: `automation-run:${task.id}`,
            },
            { phase: 'settled', conversationId },
            context,
          )
        } catch (error) {
          if (runtime.signal.aborted) throw error
          await runtime.commit(async (tx) => {
            await settle(tx, task.input.automation.id, String(task.id), 'failed', String(error))
            return terminal
          }, context)
        }
      },
      settled: async (task, runtime, context) => {
        try {
          const result = await settledSubmission(runtime, context)
          await runtime.commit(async (tx) => {
            const entry =
              result.status === 'done' && result.type === 'input'
                ? await tx.entry(AssistantEntry, result.answer)
                : undefined
            const answer = entry?.model?.[0]
            const text =
              answer?.role === 'assistant'
                ? answer.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
                : result.status === 'unanswered'
                  ? `ended without an answer (${result.reason})`
                  : undefined
            await settle(
              tx,
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
            await settle(tx, task.input.automation.id, String(task.id), 'failed', String(error))
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
  async function settle(tx: Tx, id: string, runId: string, status: Run['status'], answer?: string) {
    const state = await tx.doc(Automations)
    finish(state, id, runId, status, answer)
    const a = state.automations[id]
    if (!a || status === 'aborted') return
    const text = status === 'done' ? answer?.trim() || '(no answer)' : `Run failed: ${answer}`
    if (a.subscribers.length) await deliver(tx, a, `run:${runId}`, 'finished', text)
    delete a.branches
  }
  async function fire(tx: Tx, a: Automation, firedAt: number, text = '') {
    if (await host.want(Hold)?.held(tx, a.id)) return { id: a.id }
    const skip =
      !!a.prompt &&
      (a.runs.some((r) => r.status === 'running') || (await scanRunsBeforeWrites(tx)).has(a.id))
    const countsTowardCap = (!!a.prompt && !skip) || a.subscribers.length > 0
    a.recentFires = (a.recentFires ?? []).filter((at) => at > firedAt - FIRE_WINDOW_MS)
    if (countsTowardCap && a.recentFires.length >= MAX_FIRES_PER_HOUR) {
      const reason = 'Fired more than 6 times in an hour; paused'
      a.enabled = false
      delete a.nextAt
      if (a.script) {
        a.script.state = 'stopped'
        a.script.error = reason
      }
      await host.need(MessagesApi).dropped(tx, a.id, `Automation ${a.id} "${a.name}",`, reason)
      const event = await host.emit(tx, Escalated, { id: a.id, reason })
      await deliver(tx, a, event.id, 'escalated', reason)
      return { id: a.id }
    }
    const result = a.prompt
      ? await skipOverlappingRunOrStart(tx, a, firedAt, text, skip)
      : { id: a.id }
    if (countsTowardCap) a.recentFires.push(firedAt)
    a.fires++
    a.lastFireAt = firedAt
    const event = await host.emit(tx, Fired, { id: a.id, text, fire: a.fires })
    if (!a.prompt) {
      if (a.subscribers.length) await deliver(tx, a, event.id, 'fired', text)
      delete a.branches
    }
    return result
  }
  const activeRuns = new WeakMap<Tx, Set<string>>()
  async function scanRunsBeforeWrites(tx: Tx): Promise<Set<string>> {
    const cached = activeRuns.get(tx)
    if (cached) return cached
    const ids = new Set<string>()
    for (const status of ['pending', 'running', 'waiting', 'sleeping', 'completing'] as const) {
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
  async function skipOverlappingRunOrStart(
    tx: Tx,
    a: Automation,
    firedAt: number,
    text: string,
    skip: boolean,
  ) {
    if (skip) {
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
    a.runs = a.runs.slice(-RETAINED_RUNS)
    return a.runs.at(-1)!
  }
  type PlanFromNow = { phase: 'plan' }
  type FireOnceOnWake = { phase: 'fire'; until: number }
  const retiredSchedulerOnly = terminal
  const Scheduler = defineTask<
    { id: string },
    PlanFromNow | { phase: 'sleep'; until: number } | FireOnceOnWake,
    null
  >({
    name: 'ultimate.automation-scheduler',
    version: 1,
    initial: () => ({ phase: 'plan' }),
    phases: {
      plan: (task, runtime, context) =>
        runtime.commit(async (tx) => {
          const a = (await tx.doc(Automations)).automations[task.input.id]
          if (!a?.enabled || a.scheduler !== task.id) return retiredSchedulerOnly
          const planFromNow = () =>
            nextAt(
              a.schedule!,
              Math.max(runtime.now(), a.lastFireAt ?? a.createdAt),
              a.lastFireAt ?? a.createdAt,
            )
          const until = a.nextAt ?? planFromNow()
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
        runtime.commit(async function atomicFireRunCheckpoint(tx) {
          const a = (await tx.doc(Automations)).automations[task.input.id]
          if (!a?.enabled || a.scheduler !== task.id) return retiredSchedulerOnly
          await fire(tx, a, runtime.now())
          delete a.nextAt
          if (!a.enabled || a.schedule!.kind === 'at') {
            a.enabled = false
            delete a.scheduler
            return retiredSchedulerOnly
          }
          return { status: 'running', checkpoint: { phase: 'plan' } }
        }, context),
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  })

  return { RunTask, Scheduler, fire, scanRunsBeforeWrites }
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
