import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { access, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord'
import { Type } from '@earendil-works/pi-ai'
import {
  AgentDoc,
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
  section,
} from '@earendil-works/pi-durable'
import type { TaskId, Tx, ConversationId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ActionContext } from '../../server/actions.ts'
import { EVENT_FEED } from '../../shared/events.ts'
import type { EventRecord } from '../../shared/events.ts'
import { implementAction } from '../../lib/actions.ts'
import { actingAs } from '../../lib/acting-as.ts'
import { discoverAgents } from '../../lib/agents.ts'
import { validateName } from '../../lib/secrets.ts'
import { groupAlive } from '../../lib/process-group.ts'
import { writeJson } from '../../lib/json-file.ts'
import { SubagentsApi } from '../subagents/api.ts'
import { MessagesApi } from '../messages/api.ts'
import { LineageApi } from '../lineage/api.ts'
import { AutomationsApi } from './api.ts'
import {
  CreateAction,
  DeleteAction,
  DescribeAction,
  ListAction,
  PauseAction,
  ResumeAction,
  RunAction,
  UpdateAction,
  SubscribeAction,
  UnsubscribeAction,
  LogAction,
  ScriptAction,
  EscalateAction,
  EventsAction,
} from './refs.ts'
import { describeSchedule, nextAt, parseSchedule } from './schedule.ts'
import { scheduler } from './scheduler.ts'
import { triggers, TRIGGER_EVENTS, describeTrigger } from './triggers.ts'
import { supervisor } from './supervisor.ts'
import type { Prepared } from './supervisor.ts'
import type {
  Args,
  Automation,
  AutomationListItem,
  Effect,
  Run,
  Manifest,
  Subscriber,
} from './types.ts'
import { isSlug, STANDING } from './types.ts'
export type { Automation, Run } from './types.ts'
export { launchHandshake } from './supervisor.ts'
type Ledger = { next: number; automations: Record<string, Automation> }
export const Automations = defineDoc<Ledger>({
  kind: 'ultimate.automations',
  checkpointWhen: () => false,
  version: 3,
  scope: 'session',
  initial: () => ({ next: 1, automations: {} }),
  // Version 1 also holds schedule records from before scripts and subscribers. Version 3: a project script discovery
  // made with nobody to wake wakes @ultimate, as its manifest now says by default. Pi Durable stores the migrated
  // value as a version 3 base on the ledger's next write.
  migrate: (value) => {
    const ledger = value as unknown as Ledger
    for (const a of Object.values(ledger.automations)) {
      a.subscribers ??= []
      if (a.fires === undefined) {
        // Old records counted fires only as runs; the last run anchors the next interval, as it did then.
        a.fires = a.runs.length
        const last = a.runs.at(-1)
        if (last) a.lastFireAt = last.firedAt
      }
      if (a.scope === 'project' && !a.prompt && !a.subscribers.length) {
        a.subscribers = ['@ultimate']
        a.script!.to = '@ultimate'
      }
      // The cooldown now counts from the condition's own fire; until the next one, from the last fire of any kind.
      if (a.condition && a.condition.firedAt === undefined && a.lastFireAt !== undefined)
        a.condition.firedAt = a.lastFireAt
    }
    return ledger
  },
})
type Change = { result: JsonValue; abort?: TaskId; effect?: Effect }
/** Per tool call, by call id: a codemode script's nested calls share its task, so the task alone does not name a call. */
const Receipts = defineDoc<Record<string, Partial<Change>>>({
  kind: 'ultimate.automation-receipts',
  checkpointWhen: () => false,
  version: 1,
  scope: 'task',
  initial: () => ({}),
})
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
/** A fire must reach someone: a run, a subscriber, or both. Refuses a change that would leave neither. */
function reachesSomeone(a: Automation) {
  if (!a.prompt && !a.subscribers.length)
    throw new Error('At least one of prompt or subscribers is required')
}
function required(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${field} is required`)
  return v.trim()
}
const operations = [
  'events',
  'list',
  'create',
  'update',
  'pause',
  'resume',
  'run',
  'runs',
  'log',
  'abort',
  'escalate',
  'subscribe',
  'unsubscribe',
  'delete',
] as const
function backend(host: ExtensionHost) {
  const schedule = scheduler(host, Automations, (...args) => scripts.deliver(...args))
  const scripts = supervisor(host, Automations, schedule.fire)
  const trigger = triggers(host, Automations, schedule.fire, schedule.prepareFires)
  const {
    trusted,
    agentFor,
    projectDir,
    manifest,
    committedManifest,
    discover,
    snapshot,
    runPath,
    validId,
    agentConversation,
    deliver,
    tail,
    MANIFEST,
  } = scripts
  /** A subscriber as stored: `#id` and numbers become the conversation id, `@name` stays the standing agent's name. */
  async function subscriber(value: unknown): Promise<Subscriber> {
    if (typeof value === 'number' || (typeof value === 'string' && /^#[1-9]\d*$/.test(value))) {
      const id = typeof value === 'number' ? value : Number(value.slice(1))
      if (
        !Number.isInteger(id) ||
        id < 1 ||
        !(await host.harness().conversation(id as ConversationId, BACKGROUND_CONTEXT))
      )
        throw new Error(`Unknown subscriber #${id}`)
      return id
    }
    if (typeof value === 'string' && STANDING.test(value)) {
      // Throws for a name that is no standing agent; stored by name, it follows the agent across chapters.
      await host
        .need(SubagentsApi)
        .standing(value.slice(1), BACKGROUND_CONTEXT)
        .catch((error: unknown) => {
          throw new Error(`Unknown subscriber ${value}`, { cause: error })
        })
      return value
    }
    throw new Error('subscribers must be #id or @name')
  }
  async function prepareScript(args: Args, caller?: number): Promise<Prepared> {
    if (args.action === 'create') {
      if (!caller) throw new Error('create requires a caller conversation')
      if (args.scope !== 'project') {
        if (args.slug !== undefined) throw new Error('slug is only for project automations')
        return await agentFor(caller)
      }
      if (!(await trusted()))
        throw new Error("Choose this project's local setup before creating project automations")
      if (args.to !== undefined && !STANDING.test(args.to))
        throw new Error('A project automation wakes a standing agent: to must be @name')
      // The caller becomes a subscriber; discovery configures the watcher from @ultimate.
      if (!(await host.harness().conversation(caller as ConversationId, BACKGROUND_CONTEXT)))
        throw new Error(`Unknown caller #${caller}`)
      const slug =
        args.slug ??
        required(args.name, 'name')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^[^a-z]+|-+$/g, '')
          .slice(0, 40)
          .replace(/-+$/, '')
      if (typeof slug !== 'string' || !isSlug(slug))
        throw new Error(
          'slug must match ^[a-z][a-z0-9-]*$ (at most 63 characters) and not be an object key',
        )
      const committed: Manifest = {
        name: required(args.name, 'name'),
        ask: required(args.ask, 'ask'),
        once: args.once ?? true,
        ...(args.secrets?.length ? { secrets: args.secrets } : {}),
        to: args.to ?? '@ultimate',
      }
      const path = join(projectDir(slug), MANIFEST)
      const existing = await readFile(path, 'utf8').then(
        (text) => {
          try {
            return manifest(JSON.parse(text)) ?? null
          } catch {
            // An unreadable manifest is someone's broken automation, not ours to overwrite.
            return null
          }
        },
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
          return undefined
        },
      )
      // An equal manifest is this create's own, published before a crash: it is adopted. A different one is another
      // automation.
      const taken = () => new Error(`Automation ${slug} already exists; pass another slug`)
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(committed))
        throw taken()
      if (existing === undefined) {
        await mkdir(projectDir(slug), { recursive: true })
        // Written whole to a temporary file, then linked into place: the link is atomic and exclusive, so a crash never
        // leaves a partial manifest, and of two creates racing for one slug only one publishes.
        const draft = `${path}.${process.pid}.${randomUUID()}`
        await writeFile(draft, `${JSON.stringify(committedManifest(committed), null, 2)}\n`, {
          flush: true,
        })
        try {
          await link(draft, path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          const found = manifest(JSON.parse(await readFile(path, 'utf8')))
          if (JSON.stringify(found) !== JSON.stringify(committed)) throw taken()
        } finally {
          await rm(draft, { force: true })
        }
      }
      // Discovery alone makes project records: the create then takes the record it made.
      await discover()
      return { slug, manifest: committed }
    }
    const id = validId(args.id)
    if (!id.startsWith('A')) await discover()
    const sub = await snapshot(id)
    const prepared: Prepared = {}
    if (
      args.action === 'update' &&
      sub.scope === 'project' &&
      [args.name, args.ask, args.once, args.secrets].some((value) => value !== undefined)
    ) {
      const script = sub.script!
      // The record's own fields change with the update's commit; a discovery before then must not hide the old ask.
      prepared.previousAsk = script.ask
      await writeJson(
        join(projectDir(id), MANIFEST),
        committedManifest({
          name: args.name?.trim() ?? sub.name,
          ask: args.ask?.trim() ?? script.ask,
          once: args.once ?? script.once,
          ...((args.secrets ?? script.secrets)?.length
            ? { secrets: args.secrets ?? script.secrets }
            : {}),
          to: script.to ?? '@ultimate',
        }),
      )
    }
    if ((args.action === 'resume' || args.action === 'run') && sub.script) {
      try {
        await access(runPath(sub), constants.X_OK)
      } catch {
        throw new Error(`Missing or non-executable ${runPath(sub)}; write it and chmod +x it first`)
      }
    }
    if (args.action === 'escalate') required(args.reason, 'reason')
    if (args.action === 'subscribe' || args.action === 'unsubscribe') {
      if (args.to === undefined && !caller) throw new Error('Subscriber conversation is missing')
      // Unsubscribing takes what is stored, even a conversation since removed.
      if (args.action === 'unsubscribe' && args.to !== undefined) {
        if (!/^#[1-9]\d*$/.test(args.to) && !STANDING.test(args.to))
          throw new Error('to must be #id or @name')
        prepared.subscriber = args.to.startsWith('#') ? Number(args.to.slice(1)) : args.to
        return prepared
      }
      prepared.subscriber = await subscriber(args.to ?? caller)
    }
    return prepared
  }
  async function changeScript(
    tx: Tx,
    args: Args,
    prepared: Prepared,
    caller?: number,
  ): Promise<{ result: JsonValue; effect?: Effect }> {
    const state = await tx.doc(Automations)
    if (args.action === 'list')
      return {
        result: Object.values(state.automations).map((s) => ({
          ...s,
          alive: groupAlive(s.script?.pid),
        })),
      }
    if (args.action === 'create') {
      const name = required(args.name, 'name')
      const runProfile = {
        ...(args.prompt ? { prompt: args.prompt } : {}),
        ...(args.agent ? { agent: args.agent } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(args.thinking ? { thinking: args.thinking } : {}),
      }
      if (prepared.slug) {
        // The record discovery made from this create's manifest; one already used belongs to someone else.
        const sub = state.automations[prepared.slug]
        if (!sub)
          throw new Error(`Automation ${prepared.slug} was not discovered; check its manifest`)
        const m = prepared.manifest!
        const same =
          sub.name === m.name &&
          sub.script!.ask === m.ask &&
          sub.script!.once === m.once &&
          sub.script!.to === m.to
        if (!same || sub.script!.state !== 'stopped' || sub.script!.startedAt || sub.fires)
          throw new Error(`Automation ${prepared.slug} already exists; pass another slug`)
        Object.assign(sub, runProfile, {
          enabled: true,
          updatedAt: Date.now(),
          subscribers: [
            ...new Set([
              ...sub.subscribers,
              ...(prepared.subscribers ?? (args.prompt || !caller ? [] : [caller])),
            ]),
          ],
          ...(args.key ? { key: args.key } : {}),
        })
        sub.script!.state = 'writing'
        await deliver(tx, sub, 'create', 'writing', sub.script!.ask)
        return { result: sub }
      }
      const id = `A${state.next++}`
      const conversationId = await agentConversation(
        tx,
        prepared,
        id,
        name,
        (await tx.doc(AgentDoc, caller as ConversationId)).cwd ?? host.projectRoot,
      )
      const now = Date.now()
      const sub: Automation = {
        id,
        ...(args.key ? { key: args.key } : {}),
        name,
        enabled: true,
        script: {
          ask: required(args.ask, 'ask'),
          once: args.once ?? true,
          conversationId,
          state: 'writing',
          ...(args.secrets ? { secrets: args.secrets } : {}),
        },
        subscribers: prepared.subscribers?.length
          ? prepared.subscribers
          : args.prompt
            ? []
            : [caller!],
        ...runProfile,
        createdAt: now,
        updatedAt: now,
        runs: [],
        fires: 0,
      }
      state.automations[id] = sub
      await deliver(tx, sub, 'create', 'writing', sub.script!.ask)
      return { result: sub }
    }
    const id = validId(args.id)
    const sub = state.automations[id]
    if (!sub) throw new Error(`Unknown automation: ${id}`)
    if (args.action === 'log') return { result: { text: await tail(id, args.lines) } }
    sub.updatedAt = Date.now()
    if (args.action === 'subscribe')
      sub.subscribers = [...new Set([...sub.subscribers, prepared.subscriber!])]
    else if (args.action === 'unsubscribe') {
      sub.subscribers = sub.subscribers.filter((s) => s !== prepared.subscriber)
      reachesSomeone(sub)
    } else if (args.action === 'resume' || args.action === 'run') {
      sub.enabled = true
      sub.script!.state = 'running'
      // Retain the old pid until launch so onOpen can sweep it if the process dies before the effect.
      delete sub.script!.error
      return {
        result: sub,
        effect: {
          id,
          action: 'resume',
          ...(sub.script!.pid ? { previousPid: sub.script!.pid } : {}),
        },
      }
    } else if (args.action === 'pause' || args.action === 'delete' || args.action === 'escalate') {
      const pid = sub.script!.pid
      if (args.action === 'escalate')
        await scripts.escalate(tx, sub, required(args.reason, 'reason'))
      else {
        sub.enabled = false
        if (sub.script!.state !== 'done') sub.script!.state = 'stopped'
      }
      if (args.action === 'delete') delete state.automations[id]
      return {
        result: args.action === 'delete' ? { id } : sub,
        effect: { id, action: 'pause', ...(pid ? { previousPid: pid } : {}) },
      }
    }
    return { result: sub }
  }

  async function validate(args: Args, caller?: number) {
    if (!host.extensions().some((e) => e.name === 'subagents' && e.enabled))
      throw new Error('automations needs the subagents extension enabled')
    if (!operations.includes(args.action as (typeof operations)[number]))
      throw new Error(`Unknown action: ${args.action}`)
    if (args.agent) {
      const found = (
        await discoverAgents(host.ultimateRoot, host.projectRoot, host.userHome, host.modelRuntime)
      ).definitions.some((d) => d.name === args.agent)
      if (!found) throw new Error(`Unknown agent: ${args.agent}`)
    }
    if (args.model && !host.modelRuntime.getModel(args.model.provider, args.model.modelId))
      throw new Error('Unknown model')
    if (args.action === 'create') {
      required(args.name, 'name')
      if (
        [args.schedule, args.ask, args.event, args.condition].filter((value) => value !== undefined)
          .length !== 1
      )
        throw new Error('Exactly one of schedule, ask, event or condition is required')
      if (args.scope !== undefined && args.scope !== 'user' && args.scope !== 'project')
        throw new Error('scope must be user or project')
      if (args.scope === 'project' && args.ask === undefined)
        throw new Error('Project scope is only supported for script triggers')
      if (args.slug !== undefined && args.scope !== 'project')
        throw new Error('slug is only for project automations')
      if (args.schedule !== undefined) parseSchedule(args.schedule)
      if (args.ask !== undefined) required(args.ask, 'ask')
      if (!args.prompt && !args.subscribers?.length && !caller && args.scope !== 'project')
        throw new Error('At least one of prompt or subscribers is required')
      if (args.subscribers !== undefined && !Array.isArray(args.subscribers))
        throw new Error('subscribers must be #id or @name')
      if (args.key !== undefined && (typeof args.key !== 'string' || !args.key.trim()))
        throw new Error('key must be a non-empty string')
    }
    if (args.event !== undefined) {
      const event = TRIGGER_EVENTS.find(({ name }) => name === args.event!.name)
      if (!event) throw new Error(`Unknown event: ${args.event.name}`)
      for (const [key, value] of Object.entries(args.event.where ?? {})) {
        if (!Object.hasOwn(event.fields, key)) throw new Error(`Unknown where field: ${key}`)
        if (!['string', 'number', 'boolean'].includes(typeof value))
          throw new Error('where values must be strings, numbers or booleans')
      }
    }
    if (args.condition !== undefined) {
      const c = args.condition
      if (c.metric !== 'context') throw new Error('condition metric must be context')
      if (!Number.isInteger(c.above) || c.above < 1 || c.above > 99)
        throw new Error('above must be an integer from 1 to 99')
      if (c.cooldownMs !== undefined && (!Number.isFinite(c.cooldownMs) || c.cooldownMs < 0))
        throw new Error('cooldownMs must be non-negative')
      if (c.idleFor !== undefined && (!Number.isFinite(c.idleFor) || c.idleFor < 0))
        throw new Error('idleFor must be non-negative')
      const target = typeof c.of === 'string' ? await trigger.resolve(c.of) : undefined
      if (!target || !(await host.harness().conversation(target, BACKGROUND_CONTEXT)))
        throw new Error(`Unknown of: ${c.of}`)
    }
    if (args.name !== undefined) required(args.name, 'name')
    // An empty prompt on update removes the run action; create needs a real one.
    if (args.prompt !== undefined && (args.action === 'create' || args.prompt !== ''))
      required(args.prompt, 'prompt')
    if (args.once !== undefined && typeof args.once !== 'boolean')
      throw new Error('once must be boolean')
    if (
      args.secrets !== undefined &&
      (!Array.isArray(args.secrets) || args.secrets.some((s) => typeof s !== 'string'))
    )
      throw new Error('secrets must be names')
    args.secrets?.forEach(validateName)
    if (args.action === 'update') {
      const a = await scripts.status(required(args.id, 'id'))
      // A schedule, event or condition may become another of these; a script stays a script.
      const kinds = [args.schedule, args.event, args.condition].filter((v) => v !== undefined)
      if (
        (args.ask !== undefined && !a.script) ||
        (kinds.length > 0 && !!a.script) ||
        kinds.length > 1
      )
        throw new Error('Cannot change trigger kind')
      if (args.ask !== undefined) required(args.ask, 'ask')
    }
  }
  async function prepare(args: Args, caller?: number): Promise<Prepared> {
    // A key that already made an automation is answered from it before anything else runs: validation may make a
    // standing agent's conversation, and preparation may publish a manifest. The transaction checks it is still there.
    if (
      args.action === 'create' &&
      typeof args.key === 'string' &&
      Object.values(
        (await host.harness().snapshot(Automations, BACKGROUND_CONTEXT))?.automations ?? {},
      ).some((a) => a.key === args.key)
    )
      return { keyed: true }
    await validate(args, caller)
    if (args.action === 'create') {
      const subscribers = args.subscribers?.length
        ? [...new Set(await Promise.all(args.subscribers.map(subscriber)))]
        : undefined
      const prepared: Prepared = {
        ...(args.ask !== undefined ? await prepareScript(args, caller) : {}),
        ...(subscribers ? { subscribers } : {}),
      }
      if (args.condition) prepared.target = await trigger.resolve(args.condition.of)
      return prepared
    }
    if (args.action === 'list') {
      await scripts.discover()
      return {}
    }
    if (args.action === 'events') return {}
    const prepared: Prepared = await prepareScript(args, caller)
    const condition =
      args.condition ??
      (args.action === 'resume'
        ? (await scripts.status(required(args.id, 'id'))).condition
        : undefined)
    if (condition) prepared.target = await trigger.resolve(condition.of)
    return prepared
  }
  async function change(
    tx: Tx,
    args: Args,
    prepared: Awaited<ReturnType<typeof prepare>>,
    caller?: number,
  ): Promise<Change> {
    if (args.action === 'events') return { result: json(TRIGGER_EVENTS) }
    const state = await tx.doc(Automations)
    if (args.action === 'list') return changeScript(tx, args, prepared, caller)
    if (args.action === 'create' && args.key !== undefined) {
      // A caller that lost its create's receipt (a crash, a retry) gets the automation it made, not a second one.
      const made = Object.values(state.automations).find((a) => a.key === args.key)
      if (made) return { result: json(made) }
      if (prepared.keyed)
        throw new Error(`The automation for key ${args.key} was deleted meanwhile; create it again`)
    }
    if (args.action === 'create' && args.ask !== undefined)
      return changeScript(tx, args, prepared, caller)
    const id = args.action === 'create' ? `A${state.next++}` : required(args.id, 'id')
    if (args.action === 'create') {
      const now = Date.now()
      state.automations[id] = {
        id,
        name: required(args.name, 'name'),
        ...(args.schedule !== undefined ? { schedule: parseSchedule(args.schedule) } : {}),
        enabled: true,
        createdAt: now,
        updatedAt: now,
        runs: [],
        fires: 0,
        ...(args.key ? { key: args.key } : {}),
        subscribers: prepared.subscribers?.length
          ? prepared.subscribers
          : args.prompt
            ? []
            : [caller!],
      }
    }
    const a = state.automations[id]
    if (!a) throw new Error(`Unknown automation: ${id}`)
    if (args.action === 'runs') return { result: a.runs }
    if (args.action === 'run' && !a.script)
      return { result: await schedule.fire(tx, a, Date.now()) }
    if (args.action === 'abort') {
      const run = a.runs.find((r) => r.id === args.runId)
      if (!run || run.status !== 'running') throw new Error('runId must identify a running run')
      return { result: { id: run.id }, abort: Number(run.id) as TaskId }
    }
    if (
      ['subscribe', 'unsubscribe'].includes(args.action) ||
      (a.script && args.action !== 'update')
    )
      return changeScript(tx, args, prepared, caller)
    if (args.action === 'escalate') throw new Error('escalate requires a script trigger')
    if (args.action === 'log') throw new Error('log requires a script trigger')
    if (
      args.action === 'resume' &&
      a.schedule?.kind === 'at' &&
      Date.parse(a.schedule.time) <= Date.now()
    )
      throw new Error('This one-shot time has passed; update the time first')
    const abort = a.scheduler
    const oldSchedule = a.schedule && { ...a.schedule }
    const oldAsk = prepared.previousAsk ?? a.script?.ask
    delete a.scheduler
    if (args.action !== 'update') delete a.nextAt
    if (args.action === 'delete') {
      delete state.automations[id]
      return { result: { id }, ...(abort ? { abort } : {}) }
    }
    let effect: Effect | undefined
    if (args.action === 'create' || args.action === 'update') {
      if (args.name !== undefined) a.name = required(args.name, 'name')
      if (args.prompt !== undefined) {
        if (args.prompt) a.prompt = required(args.prompt, 'prompt')
        else delete a.prompt
      }
      reachesSomeone(a)
      if (args.schedule !== undefined) {
        delete a.event
        delete a.condition
        a.schedule = parseSchedule(args.schedule)
      }
      if (args.event !== undefined) {
        delete a.schedule
        delete a.condition
        a.event = { ...args.event, sinceEvent: a.event?.sinceEvent ?? (await newestEvent(tx)) }
      }
      if (args.condition !== undefined) {
        delete a.schedule
        delete a.event
        const previousOf = a.condition?.of
        a.condition = {
          ...a.condition,
          ...args.condition,
          cooldownMs: args.condition.cooldownMs ?? a.condition?.cooldownMs ?? 3600000,
          armed: a.condition?.armed ?? true,
        }
        // Another target's input says nothing about this one: its pause counts afresh, from this update.
        if (!a.condition.idleFor) {
          delete a.condition.idleFor
          delete a.condition.inputAt
        } else if (previousOf !== undefined && previousOf !== a.condition.of)
          a.condition.inputAt = Date.now()
      }
      if (a.script) {
        if (args.ask !== undefined) a.script.ask = required(args.ask, 'ask')
        if (args.once !== undefined) a.script.once = args.once
        if (args.secrets !== undefined) a.script.secrets = args.secrets
      }
      if (args.agent !== undefined) {
        if (args.agent) a.agent = args.agent
        else delete a.agent
      }
      if (args.model !== undefined) a.model = args.model
      if (args.thinking !== undefined) a.thinking = args.thinking
      if (a.script && a.script.ask !== oldAsk) {
        // The running script watches the old condition: stop it and have the watcher write run again, as at creation.
        a.script.state = 'writing'
        delete a.script.error
        effect = {
          id,
          action: 'pause',
          ...(a.script.pid ? { previousPid: a.script.pid } : {}),
        }
      }
    } else if (args.action === 'pause') a.enabled = false
    else if (args.action === 'resume') a.enabled = true
    else throw new Error(`Unknown action: ${args.action}`)
    if (args.action === 'resume' && a.event) a.event.sinceEvent = await newestEvent(tx)
    if (args.action === 'create' || args.action === 'resume')
      await trigger.evaluate(tx, a, prepared.target)
    a.updatedAt = Date.now()
    if (effect) await deliver(tx, a, `update:${a.updatedAt}`, 'writing', a.script!.ask)
    if (!isDeepStrictEqual(a.schedule, oldSchedule)) delete a.nextAt
    if (a.enabled && a.schedule) {
      a.nextAt ??= nextAt(a.schedule, Date.now(), a.lastFireAt ?? Date.now())
      a.scheduler = await tx.createTask(
        schedule.Scheduler,
        { id },
        {
          ownership: { kind: 'conversation' },
          conversationId: ROOT_CONVERSATION_ID,
          background: true,
        },
      )
    }
    return { result: json(a), ...(abort ? { abort } : {}), ...(effect ? { effect } : {}) }
  }
  async function apply(receipt: Partial<Change>) {
    if (receipt.abort) await host.harness().abortTask(receipt.abort, BACKGROUND_CONTEXT)
    await scripts.apply(receipt.effect)
  }
  async function operate(args: Args, caller?: number): Promise<JsonValue> {
    const prepared = await prepare(args, caller)
    const receipt = await host
      .harness()
      .commit(async (tx) => json(await change(tx, args, prepared, caller)), BACKGROUND_CONTEXT)
    await apply(receipt)
    if (receipt.effect?.action === 'resume')
      return json(await scripts.status(required(args.id, 'id')))
    return receipt.result
  }
  /**
   * The newest event committed before `tx`: an event trigger activated in `tx` handles only later ones. Read from the
   * root's event feed, which every emit appends to in its own commit.
   */
  async function newestEvent(tx: Tx) {
    const feed = host.doc(EVENT_FEED)
    if (!feed) throw new Error('The event feed is not available')
    return (
      ((await tx.doc(feed, ROOT_CONVERSATION_ID)) as { events: EventRecord[] }).events.at(-1)?.id ??
      0
    )
  }
  return { ...schedule, ...scripts, prepare, change, apply, operate, trigger }
}
function input(args: unknown, action: string): Args {
  return { ...(args as Omit<Args, 'action'>), action }
}
export const actions = {
  events: implementAction(EventsAction, () => TRIGGER_EVENTS),
  list: implementAction(
    ListAction,
    async (args, { host }) =>
      (await backend(host).operate(input(args, 'list'))) as AutomationListItem[],
  ),
  create: implementAction(
    CreateAction,
    async (args, { host, conversationId }) =>
      (await backend(host).operate(input(args, 'create'), conversationId)) as Automation,
  ),
  update: implementAction(
    UpdateAction,
    async (args, { host }) => (await backend(host).operate(input(args, 'update'))) as Automation,
  ),
  pause: implementAction(
    PauseAction,
    async (args, { host }) => (await backend(host).operate(input(args, 'pause'))) as Automation,
  ),
  resume: implementAction(
    ResumeAction,
    async (args, { host }) => (await backend(host).operate(input(args, 'resume'))) as Automation,
  ),
  run: implementAction(
    RunAction,
    async (args, { host }) =>
      (await backend(host).operate(input(args, 'run'))) as Run | Automation | { id: string },
  ),
  delete: implementAction(
    DeleteAction,
    async (args, { host }) =>
      (await backend(host).operate(input(args, 'delete'))) as { id: string },
  ),
  subscribe: implementAction(
    SubscribeAction,
    async (args, { host, conversationId }) =>
      (await backend(host).operate(input(args, 'subscribe'), conversationId)) as Automation,
  ),
  unsubscribe: implementAction(
    UnsubscribeAction,
    async (args, { host, conversationId }) =>
      (await backend(host).operate(input(args, 'unsubscribe'), conversationId)) as Automation,
  ),
  log: implementAction(
    LogAction,
    async (args, { host }) => (await backend(host).operate(input(args, 'log'))) as { text: string },
  ),
  escalate: implementAction(
    EscalateAction,
    async (args, { host }) => (await backend(host).operate(input(args, 'escalate'))) as Automation,
  ),
  runs: (args: JsonValue, { host }: ActionContext) => backend(host).operate(input(args, 'runs')),
  abort: (args: JsonValue, { host }: ActionContext) => backend(host).operate(input(args, 'abort')),
  script: implementAction(ScriptAction, async (args, { host }) => {
    const api = backend(host)
    const a = await api.status(required(input(args, 'script').id, 'id'))
    if (!a.script) throw new Error('script requires a script trigger')
    const path = api.runPath(a)
    try {
      const text = await readFile(path, 'utf8')
      return { path, text: text.length > 65536 ? `${text.slice(0, 65536)}\n…` : text }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, text: '' }
      throw error
    }
  }),
  describe: implementAction(DescribeAction, (args) => {
    const schedule = parseSchedule(input(args, 'describe').schedule ?? '')
    let time = Date.now()
    const next: number[] = []
    for (let i = 0; i < (schedule.kind === 'at' ? 1 : 3); i++) {
      time = nextAt(schedule, time)
      next.push(time)
    }
    return { schedule, description: describeSchedule(schedule), next }
  }),
}
export const pollActions = ['list', 'log', 'script']
export default function automations(host: ExtensionHost) {
  host.need(SubagentsApi)
  host.need(MessagesApi)
  const api = backend(host)
  host.implement(AutomationsApi, {
    create: async (args) => (await api.operate({ ...args, action: 'create' })) as Automation,
    delete: async (id) => void (await api.operate({ action: 'delete', id })),
    resume: async (id) => (await api.operate({ action: 'resume', id }), api.status(id)),
    pause: async (id) => (await api.operate({ action: 'pause', id }), api.status(id)),
    run: async (id) => (await api.operate({ action: 'run', id }), api.status(id)),
    status: api.status,
    read: async (tx, id) => {
      const a = (await tx.doc(Automations)).automations[id]
      return a && json(a)
    },
  })
  api.trigger.install()
  host.onOpen(async () => {
    await api.open()
    await api.trigger.open()
  })
  const close = async () => {
    await api.trigger.close()
    await api.close()
  }
  host.onRelease(close)
  host.onClose(close)
  return defineExtension({
    name: 'automations',
    tasks: [api.Scheduler, api.RunTask, api.Deliver],
    hooks: [
      hook(GenerationTask, {
        onYield: async (answer, hookApi, ctx) => {
          // Through the hook's reader: a Session read here would queue behind the generation that is yielding.
          const ledger = await hookApi.snapshot(Automations, ctx)
          const watched = Object.values(ledger?.automations ?? {}).some(
            (a) => a.script?.conversationId === hookApi.conversationId,
          )
          if (!watched) return undefined
          const text = answer.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
          await api.watcherYielded(hookApi.conversationId, text.join('\n'))
          return undefined
        },
      }),
    ],
    sections: [
      section('automations', async ({ read }, context) => {
        const state = await read.snapshot(Automations, context)
        const lines = Object.values(state?.automations ?? {})
          .filter((a) => a.enabled)
          .map((a) => `${a.id} ${a.name}: ${describeTrigger(a)}`)
        // Always rendered: a section that disappears and reappears reorders the prompt, which rebuilds it whole.
        return lines.length ? lines.join('\n') : 'None enabled.'
      }),
    ],
    tools: [
      defineTool({
        name: 'automation',
        // Receipts deduplicate ledger changes; process effects reuse their committed pid on replay.
        replay: 'safe',
        // Calls in one round apply in the order written: a parallel unsubscribe could otherwise commit before the
        // subscribe meant to replace it and be refused for leaving nobody to wake.
        executionMode: 'sequential',
        description:
          'Automate background work with one trigger (schedule, ask, event or condition) and one or both actions (prompt, subscribers). create {name,schedule?|ask?|event?|condition?,once?,secrets?,prompt?,agent?,model?,thinking?,subscribers?: (#id|@name)[],scope?,slug?,to?,key?}. To be reminded or woken, subscribe (cheap); add a prompt only when fresh work must run. @name subscribers follow that standing agent across chapters. key makes create idempotent: a repeated key returns the automation it made. ask starts a watcher that writes a supervised script: stdout FIRE wakes subscribers and/or starts a prompt run; DONE then exit 0 stops recurring scripts. event {name,where?} watches domain events; events lists names and fields. condition {metric:"context",of:"@name"|"#id",above:1-99,cooldownMs?,idleFor?} watches context fill; idleFor (ms) waits until the user gave it no input for that long. Scripts spend tokens only on setup and repair; prompt runs spend tokens every fire. Schedules: cron "0 9 * * 1-5" Europe/Vienna, at 2026-12-01T09:00:00Z, in 30m, every 15m. IDs A<n>, or lowercase slugs for project scripts in <project>/.ultimate/automations/<slug>/; the to (@name, default @ultimate) in their automation.json is woken on every machine. Project scripts never start themselves. list; update; pause/resume; run (fire trigger now or relaunch script); runs; log {id,lines?}; abort {id,runId}; escalate {id,reason}; subscribe/unsubscribe {id,to?: "#id"|"@name"} (default caller); delete (keeps files and conversations). Without prompt or subscribers, caller subscribes. Optional agent selects an existing definition (isolates ignored), model {provider,modelId} and thinking override it; otherwise runs copy the root agent. Failures wake only the watcher; the third in a row, or a watcher ending its turn mid-repair, escalates: subscribers and @ultimate are notified.',
        parameters: Type.Object({
          action: Type.Union(operations.map((v) => Type.Literal(v))),
          id: Type.Optional(Type.String()),
          name: Type.Optional(Type.String()),
          schedule: Type.Optional(Type.String()),
          ask: Type.Optional(Type.String()),
          event: Type.Optional(
            Type.Object({
              name: Type.String(),
              where: Type.Optional(
                Type.Record(
                  Type.String(),
                  Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
                ),
              ),
            }),
          ),
          condition: Type.Optional(
            Type.Object({
              metric: Type.Literal('context'),
              of: Type.String(),
              above: Type.Integer({ minimum: 1, maximum: 99 }),
              cooldownMs: Type.Optional(Type.Number({ minimum: 0 })),
              idleFor: Type.Optional(Type.Number({ minimum: 0 })),
            }),
          ),
          once: Type.Optional(Type.Boolean()),
          secrets: Type.Optional(Type.Array(Type.String())),
          prompt: Type.Optional(Type.String()),
          agent: Type.Optional(Type.String()),
          model: Type.Optional(Type.Object({ provider: Type.String(), modelId: Type.String() })),
          thinking: Type.Optional(
            Type.Union(
              ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((v) =>
                Type.Literal(v),
              ),
            ),
          ),
          subscribers: Type.Optional(
            Type.Array(Type.Union([Type.Integer({ minimum: 1 }), Type.String()])),
          ),
          scope: Type.Optional(Type.Union([Type.Literal('user'), Type.Literal('project')])),
          slug: Type.Optional(Type.String()),
          key: Type.Optional(Type.String()),
          runId: Type.Optional(Type.String()),
          to: Type.Optional(Type.String()),
          lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
          reason: Type.Optional(Type.String()),
        }),
        execute: async (args, tool, context) => {
          const cached = await tool.memo<{ output: { type: 'text'; text: string }[] }>(
            'result',
            context,
          )
          if (cached) return cached
          const caller =
            args.action === 'create' || args.action === 'subscribe'
              ? await actingAs(host, tool.conversationId, context)
              : tool.conversationId
          let receipt = await tool.commit(
            async (tx) => json((await tx.doc(Receipts, tool.taskId))[tool.callId] ?? {}),
            context,
          )
          if (receipt.result === undefined) {
            const prepared = await api.prepare(args, caller)
            receipt = await tool.commit(async (tx) => {
              const saved = await tx.doc(Receipts, tool.taskId)
              saved[tool.callId] ??= json(await api.change(tx, args, prepared, caller))
              return json(saved[tool.callId])
            }, context)
          }
          await api.apply(receipt)
          if (caller !== tool.conversationId)
            await host
              .need(LineageApi)
              .leaveNote(
                caller,
                `Side chat #${tool.conversationId} ${args.action === 'create' ? 'created' : 'subscribed to'} automation ${(receipt.result as Automation).id}.`,
                {
                  from: tool.conversationId,
                  requestId: `sidechat:automation:${tool.taskId}:${tool.callId}`,
                },
              )
          return tool.memo(
            'result',
            { output: [{ type: 'text' as const, text: concise(receipt.result!) }] },
            context,
          )
        },
      }),
    ],
  })
}
function concise(value: JsonValue): string {
  if (Array.isArray(value)) return value.length ? value.map(concise).join('\n') : 'None.'
  if (value && typeof value === 'object' && 'enabled' in value) {
    const a = value as Automation
    const to = a.subscribers.map((s) => (typeof s === 'number' ? `#${s}` : s)).join(', ')
    return `${a.id} ${a.name} — ${describeTrigger(a)} — ${a.enabled ? 'enabled' : 'paused'}${to ? ` → ${to}` : ''}`
  }
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text
  return JSON.stringify(value)
}
