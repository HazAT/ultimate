import { parseConversationId } from '../../lib/ids.ts'
import type {
  ConversationId,
  ConversationRecord,
  Cursor,
  EntryId,
  EntryRecord,
  TaskId,
  ToolExecutionApi,
  SubmissionRecord,
} from '@earendil-works/pi-durable'
import { existsSync } from 'node:fs'
import { onCommit } from '../../lib/commits.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import { arr, bool, int, obj, opt, str } from '@earendil-works/pi-schema'
import { strEnum } from '../../lib/schema.ts'
import type { AssistantMessage, ModelThinkingLevel } from '@earendil-works/pi-ai'
import {
  AgentDoc,
  AssistantEntry,
  configure,
  ToolResultEntry,
  defineExtension,
  defineTask,
  defineTool,
  LiveDoc,
  InboxDoc,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
  section,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { Source } from '../../lib/project-paths.ts'
import {
  agentRoots,
  deleteDefinition,
  discoverAgents,
  hasLogin,
  hostDefault,
  parseCache,
  previewModel,
  saveDefinition,
  saveOverlay,
} from '../../lib/agents.ts'
import type { AgentDefinition, DefinitionFields } from '../../lib/agents.ts'
import { createChild, reconfigure, started } from './children.ts'
import { implementAction } from '../../lib/actions.ts'
import { exec } from '../../lib/exec.ts'
import { shortTitle } from '../../lib/title.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { MessageEntry, ReplyEntry } from '../entries/api.ts'
import { ConversationsApi, Marks } from '../conversations/api.ts'
import type { AgentMarkStyle } from '../conversations/refs.ts'
import { Pin } from '../models/api.ts'
import { Profile, Runs, Standing, Subagents, SubagentsApi } from './api.ts'
import type { SubagentsService } from './api.ts'
import { definitionRuns, refName, refOf } from '../../lib/families.ts'
import { readFamilies } from '../../lib/families-settings.ts'
import {
  DefinitionAction,
  DefinitionsAction,
  DeleteDefinitionAction,
  SaveDefinitionAction,
  StandingAction,
} from './refs.ts'
import { safeToRerun } from '../../lib/replay.ts'

export const docs = [Subagents, Standing, Profile, Runs]

const ADHOC = `You were made for one task: do what your brief asks, and only that. Read the code and the repository instructions it touches first. Never delegate or push. Report problems instead of working around them. Answer with conclusions and their evidence (\`path:line\`, commands with their output), not dumps; say what you could not confirm.`
const WRITE_TOOLS = ['edit', 'write']
const preserveUneditedAppearance = (existing: AgentDefinition | undefined) => ({
  ...(existing?.title ? { title: existing.title } : {}),
  ...(existing?.icon ? { icon: existing.icon } : {}),
  ...(existing?.tint ? { tint: existing.tint } : {}),
})

const setMark = (
  marks: Record<string, AgentMarkStyle>,
  { name, title, icon, tint }: AgentDefinition,
) => {
  if (title || icon || tint)
    marks[name] = {
      ...(title ? { title } : {}),
      ...(icon ? { icon } : {}),
      ...(tint ? { tint } : {}),
    }
  else delete marks[name]
}

export const runsLabel = (runs: AgentDefinition['runs']) =>
  [
    runs?.family && (runs.model ? `${runs.family}:` : runs.family),
    runs?.model && `${runs.model.provider}/${runs.model.modelId}`,
    runs?.thinking && `· ${runs.thinking}`,
  ]
    .filter(Boolean)
    .join(' ')
const Anchor = defineTask<null, { phase: 'done' }, null>({
  name: 'ultimate.subagent-anchor',
  version: 1,
  initial: () => ({ phase: 'done' }),
  phases: {
    done: (_task, runtime, context) =>
      runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
        context,
      ),
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
})
const textOf = (message: AssistantMessage | undefined) =>
  (message?.content ?? []).flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
const reportRequestForAnswer = (answer: EntryId) => `subagent-answer:${answer}`
const hasCompletedTextAnswer = (message: AssistantMessage | undefined) =>
  message !== undefined &&
  message.stopReason !== 'aborted' &&
  message.stopReason !== 'error' &&
  textOf(message).trim() !== ''
const unanswered = (message: AssistantMessage | undefined) =>
  `ended its turn without an answer${message?.stopReason === 'aborted' || message?.stopReason === 'error' ? ` (${message.stopReason})` : ''}`
const answerText = (message: AssistantMessage | undefined) =>
  `Returned model: ${message?.provider && message?.model ? `${message.provider}/${message.model}` : 'unknown'}\n${textOf(message)}`
const reportText = (id: ConversationId, agent: string, message: AssistantMessage | undefined) =>
  hasCompletedTextAnswer(message)
    ? `[subagent ${id} (${agent}) answered] ${answerText(message)}`
    : `[subagent ${id} failed: ${unanswered(message)}]`
const replyText = (id: ConversationId, message: AssistantMessage | undefined) =>
  hasCompletedTextAnswer(message)
    ? answerText(message)
    : `Subagent ${id} ${unanswered(message)}. Message it to continue.`
function createReporter() {
  return defineTask<
    {
      conversationId: ConversationId
      text: string
      steer: boolean
      sourceEntry?: EntryId
      answer?: EntryId
    },
    { phase: 'deliver' } | { phase: 'report'; report?: string; answer?: EntryId },
    null
  >({
    name: 'ultimate.subagent-reporter',
    version: 1,
    initial: (input) =>
      input.answer === undefined
        ? { phase: 'deliver' }
        : { phase: 'report', report: input.text, answer: input.answer },
    phases: {
      deliver: async (task, runtime, context) => {
        try {
          const child = (await runtime.conversation(task.input.conversationId, context))!
          const content = task.input.text
          const settled = await (
            await child.submit(
              {
                type: 'input',
                content,
                entry: {
                  kind: 'subagents.instruction',
                  data: {
                    sender: runtime.conversationId,
                    kind: 'instruction',
                    agent: (await runtime.snapshot(Subagents, runtime.conversationId, context))!
                      .agents[String(child.id)].agent,
                    body: content,
                    ...(task.input.sourceEntry ? { entry: task.input.sourceEntry } : {}),
                  },
                },
                whenBusy: task.input.steer ? 'steer' : 'followUp',
                requestId: `subagent:${task.id}`,
              },
              context,
            )
          ).wait(context)
          await runtime.commit(async (tx) => {
            const state = await tx.doc(Subagents, runtime.conversationId)
            const action = Object.values(state.actions).find(
              (candidate) => candidate.reporter === task.id,
            )!
            action.status = settled.status
            const agent = state.agents[String(child.id)]
            if (settled.status === 'done' && settled.type === 'input') {
              action.answer = settled.answer
              if (agent.reported.includes(settled.answer))
                return { status: 'running', checkpoint: { phase: 'report' } }
              agent.reported.push(settled.answer)
              const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as
                | AssistantMessage
                | undefined
              return {
                status: 'running',
                checkpoint: {
                  phase: 'report',
                  report: reportText(child.id, agent.agent, answer),
                  answer: settled.answer,
                },
              }
            }
            const providerFailureBelongsToWatchdog =
              settled.status === 'unanswered' &&
              (settled.reason === 'model_error' || settled.reason === 'no_model')
            if (providerFailureBelongsToWatchdog) {
              action.status = 'failed'
              return { status: 'running', checkpoint: { phase: 'report' } }
            }
            if (settled.status === 'unanswered' && settled.reason !== 'aborted') {
              const failure = settled.reason
              return { status: 'running', checkpoint: { phase: 'report', report: failure } }
            }
            const childStopped = settled.status === 'unanswered'
            if (childStopped) action.status = 'interrupted'
            return { status: 'running', checkpoint: { phase: 'report' } }
          }, context)
        } catch (error) {
          if (runtime.signal.aborted) throw error
          const message = error instanceof Error ? error.message : String(error)
          await runtime.commit(async (tx) => {
            const state = await tx.doc(Subagents, runtime.conversationId)
            const action = Object.values(state.actions).find(
              (candidate) => candidate.reporter === task.id,
            )!
            action.status = 'failed'
            return {
              status: 'running',
              checkpoint: {
                phase: 'report',
                report: message,
              },
            }
          }, context)
        }
      },
      report: async (task, runtime, context) => {
        const { report, answer } = task.state.checkpoint
        if (report !== undefined) {
          const parent = (await runtime.conversation(runtime.conversationId, context))!
          const agent = (await runtime.snapshot(Subagents, runtime.conversationId, context))!
            .agents[String(task.input.conversationId)].agent
          let message: AssistantMessage | undefined
          if (answer !== undefined)
            await runtime.commit(async (tx) => {
              message = (await tx.entry(answer))?.model?.[0] as AssistantMessage | undefined
            }, context)
          const failed = !hasCompletedTextAnswer(message)
          const body =
            answer === undefined
              ? `Failed: ${report}`
              : failed
                ? `Failed: ${unanswered(message)}`
                : answerText(message)
          await parent.submit(
            {
              type: 'input',
              content:
                answer === undefined
                  ? `[subagent ${task.input.conversationId} failed: ${report}]`
                  : report,
              entry: {
                kind: 'subagents.report',
                data: {
                  sender: task.input.conversationId,
                  kind: 'report',
                  agent,
                  failed,
                  body,
                  ...(answer ? { entry: answer } : {}),
                },
              },
              whenBusy: 'steer',
              requestId:
                answer === undefined
                  ? `subagent-report:${task.id}`
                  : reportRequestForAnswer(answer),
            },
            context,
          )
        }
        await runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
          context,
        )
      },
    },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const state = await tx.doc(Subagents, runtime.conversationId)
        const action = Object.values(state.actions).find(
          (candidate) => candidate.reporter === task.id,
        )!
        action.status ??= 'unanswered'
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, context),
  })
}

const details = (
  conversationId: ConversationId,
  background: boolean,
  delivery?: { yielded?: true; answerId?: EntryId },
) => ({
  conversationId,
  ...(background ? { background } : {}),
  ...delivery,
})
const reply = (text: string, info?: ReturnType<typeof details>) => ({
  output: [{ type: 'text' as const, text }],
  ...(info === undefined ? {} : { details: info }),
})

async function waitForChildLocally(
  api: ToolExecutionApi,
  id: ConversationId,
  reporters: TaskId[],
  idle: boolean,
  context: Context,
) {
  await api.commit(async (tx) => {
    await tx.doc(InboxDoc, api.conversationId)
  }, context)
  const local = withCancel(context)
  const inbox = (await api.watchDoc(InboxDoc, api.conversationId, local.context))!
  let wake!: () => void
  const steering = new Promise<void>((resolve) => {
    wake = resolve
  })
  const inspect = (value: typeof inbox.value) => {
    if (value?.items.some((item) => item.mode === 'steer')) wake()
  }
  inbox.start(async (call) => {
    if (call.kind === 'value') inspect(call.value)
  })
  inspect(inbox.value)
  const child = (await api.conversation(id, context))!
  const reportersReady = async () => {
    if (idle && (await api.snapshot(LiveDoc, id, context))?.run !== undefined) return false
    for (const reporter of reporters) {
      const task = await api.getTask(reporter, context)
      if (
        task?.state.status !== 'terminal' &&
        !(
          task?.state.status === 'running' &&
          (task.state.checkpoint as { phase?: string } | null)?.phase === 'report'
        )
      )
        return false
    }
    return true
  }
  const completion = async () => {
    for (const reporter of reporters) await api.waitForTask(reporter, local.context)
    if (idle) await child.waitForIdle(local.context)
  }
  try {
    const result = await Promise.race([
      completion().then(() => true),
      steering.then(async () => {
        if (await reportersReady()) {
          await completion()
          return true
        }
        return false
      }),
    ])
    return result
  } finally {
    local.cancel()
    await inbox.stop()
  }
}

export const reloadOnSettings = true

export const actions = {
  standing: implementAction(StandingAction, async (args, { host }) => {
    const { name } = (args ?? {}) as Record<string, JsonValue>
    if (typeof name !== 'string') throw new Error('name is required')
    return host.need(SubagentsApi).standing(name, BACKGROUND_CONTEXT)
  }),
  definitions: implementAction(DefinitionsAction, async (_args, { host }) => {
    const { definitions, errors, projectSetup } = await discoverAgents(
      host.ultimateRoot,
      host.projectRoot,
      host.userHome,
      host.modelRuntime,
    )
    const main = await (await host
      .harness()
      .conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT))!.agent(BACKGROUND_CONTEXT)
    return {
      definitions: definitions.map(({ instructions: _instructions, ...definition }) => definition),
      errors,
      main: {
        ...(main.model ? { model: main.model } : {}),
        ...(main.thinkingLevel ? { thinking: main.thinkingLevel } : {}),
        tools: [
          ...new Map([...main.tools, ...main.deferred].map((tool) => [tool.name, tool])).values(),
        ].map((tool) => ({ name: tool.name, description: tool.description })),
      },
      skills: host
        .skills(host.projectRoot)
        .map((skill) => ({ name: skill.name, description: skill.description })),
      scopes: {
        user: join(host.userHome, '.ultimate/agents'),
        project: join(host.projectRoot, '.ultimate/agents'),
      },
      projectSetup,
    }
  }),
  definition: implementAction(DefinitionAction, async (args, { host }) => {
    const name = (args as { name?: JsonValue } | null)?.name
    if (typeof name !== 'string' || !name) throw new Error('name is required')
    const { definitions, errors } = await discoverAgents(
      host.ultimateRoot,
      host.projectRoot,
      host.userHome,
      host.modelRuntime,
    )
    const definition = definitions.find((candidate) => candidate.name === name)
    const invalid = errors.findLast((candidate) => candidate.name === name)
    const shown = definition ?? invalid
    if (!shown) throw new Error(`Unknown agent: ${name}`)
    const files: Source[] = []
    for (const root of await agentRoots(host.ultimateRoot, host.projectRoot, host.userHome))
      if (existsSync(join(root.path, `${name}.md`))) files.push(root.source)
    return {
      ...(definition ? { definition } : {}),
      ...(invalid ? { invalid } : {}),
      source: shown.source,
      path: shown.path,
      raw: await readFile(shown.path, 'utf8'),
      files,
    }
  }),
  saveDefinition: implementAction(SaveDefinitionAction, async (args, { host }) => {
    const { name, scope, frontmatter, instructions, create, overlay } = (args ?? {}) as Record<
      string,
      JsonValue
    >
    if (typeof name !== 'string') throw new Error('name is required')
    if (scope !== 'user' && scope !== 'project') throw new Error('scope must be user or project')
    if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter))
      throw new Error('frontmatter must be an object')
    if (typeof instructions !== 'string') throw new Error('instructions must be a string')
    const {
      description,
      model,
      thinking,
      family,
      tools,
      denyTools,
      skills,
      isolate,
      resident,
      fast,
      summaries,
      cache,
    } = frontmatter
    if (typeof description !== 'string') throw new Error('description is required')
    if (model !== undefined && typeof model !== 'string') throw new Error('model must be a string')
    if (thinking !== undefined && typeof thinking !== 'string')
      throw new Error('thinking must be a string')
    if (family !== undefined && typeof family !== 'string')
      throw new Error('family must be a string')
    if (
      tools !== undefined &&
      (!Array.isArray(tools) || !tools.every((tool) => typeof tool === 'string'))
    )
      throw new Error('tools must be a list of tool names')
    if (
      denyTools !== undefined &&
      (!Array.isArray(denyTools) || !denyTools.every((tool) => typeof tool === 'string'))
    )
      throw new Error('denyTools must be a list of tool names')
    if (
      skills !== undefined &&
      (!Array.isArray(skills) || !skills.every((skill) => typeof skill === 'string'))
    )
      throw new Error('skills must be a list of skill names')
    if (isolate !== undefined && isolate !== 'none' && isolate !== 'worktree')
      throw new Error('isolate must be none or worktree')
    if (resident !== undefined && typeof resident !== 'boolean')
      throw new Error('resident must be a boolean')
    if (fast !== undefined && typeof fast !== 'boolean') throw new Error('fast must be a boolean')
    if (summaries !== undefined && typeof summaries !== 'boolean')
      throw new Error('summaries must be a boolean')
    const { definitions } = await discoverAgents(
      host.ultimateRoot,
      host.projectRoot,
      host.userHome,
      host.modelRuntime,
    )
    const existing = definitions.find((definition) => definition.name === name)
    if (create === true && existing) throw new Error(`A definition named ${name} exists already`)
    const fields: DefinitionFields = {
      description,
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
      ...(family ? { family } : {}),
      ...(tools ? { tools } : {}),
      ...(denyTools?.length ? { denyTools } : {}),
      ...(skills ? { skills } : {}),
      ...(isolate ? { isolate } : {}),
      ...(resident !== undefined ? { resident } : {}),
      ...(fast ? { fast } : {}),
      ...(!summaries ? { summaries } : {}),
      ...(cache !== undefined ? { cache: parseCache(cache) } : {}),
      ...preserveUneditedAppearance(existing),
    }
    const needsDiffOverlay =
      existing?.overlays?.length || (overlay === true && existing && existing.source !== scope)
    if (needsDiffOverlay) {
      await saveOverlay(host, host.modelRuntime, scope, name, fields, instructions)
      const { definitions: saved } = await discoverAgents(
        host.ultimateRoot,
        host.projectRoot,
        host.userHome,
        host.modelRuntime,
      )
      return saved.find((definition) => definition.name === name)!
    }
    return saveDefinition(host, host.modelRuntime, scope, name, fields, instructions)
  }),
  deleteDefinition: implementAction(DeleteDefinitionAction, async (args, { host }) => {
    const { name, scope } = (args ?? {}) as Record<string, JsonValue>
    if (typeof name !== 'string') throw new Error('name is required')
    if (scope !== 'user' && scope !== 'project') throw new Error('scope must be user or project')
    return deleteDefinition(host, scope, name)
  }),
}

export default function subagents(
  host: Pick<
    ExtensionHost,
    | 'ultimateRoot'
    | 'projectRoot'
    | 'userHome'
    | 'harness'
    | 'metadata'
    | 'modelRuntime'
    | 'settings'
    | 'home'
    | 'projectSettings'
    | 'need'
    | 'implement'
    | 'resource'
    | 'extensions'
    | 'notice'
    | 'onOpen'
    | 'onClose'
    | 'scanSubmissions'
    | 'emit'
  >,
) {
  const conversations = host.need(ConversationsApi)
  const workspaces = host.need(WorkspacesApi)
  const residentDefinitions = async () =>
    (
      await discoverAgents(host.ultimateRoot, host.projectRoot, host.userHome, host.modelRuntime)
    ).definitions.filter((definition) => definition.resident === true)
  const pruneRetired = async (ctx: Context) => {
    const { definitions, errors } = await discoverAgents(
      host.ultimateRoot,
      host.projectRoot,
      host.userHome,
      host.modelRuntime,
    )
    const kept = new Set(
      definitions
        .filter((definition) => definition.resident === true)
        .map((definition) => definition.name),
    )
    await host.harness().commit(async (tx) => {
      const marks = await tx.doc(Marks, ROOT_CONVERSATION_ID)
      for (const name of Object.keys(marks)) delete marks[name]
      for (const definition of definitions)
        if (definition.resident === true) setMark(marks, definition)
      const index = await tx.doc(Standing, ROOT_CONVERSATION_ID)
      for (const name of Object.keys(index)) {
        const id = index[name]
        const exists = await tx.conversation(id)
        const keepStanding = kept.has(name) || errors.length > 0
        if (keepStanding) {
          if (exists) {
            await conversations.setAutomaticSummaries(tx, id, false)
            await conversations.setStanding(tx, id, true)
          }
          continue
        }
        delete index[name]
        if (exists) {
          delete (await tx.doc(host.metadata, id)).label
          await conversations.setStanding(tx, id, false)
        }
      }
    }, ctx)
  }
  host.implement(Pin, {
    async pin(tx, id) {
      const profile = await tx.doc(Profile, id)
      if (profile.adhoc) return undefined
      const name = profile.definition ?? (await tx.doc(host.metadata, id)).label
      if (!name) return undefined
      const { definitions } = await discoverAgents(
        host.ultimateRoot,
        host.projectRoot,
        host.userHome,
        host.modelRuntime,
      )
      const definition = definitions.find((item) => item.name === name)
      return definition?.runs ? definition.runs.model : definition?.model
    },
  })
  const service: SubagentsService = {
    async createChild(tx, options) {
      const child = await createChild(host, tx, options)
      await started(host, tx, child, options.definition?.name ?? options.label, 'child')
      return child
    },
    async reconfigure(tx, id, { definition, parentAgent, modelRuntime }) {
      await reconfigure(tx, id, definition, parentAgent, modelRuntime)
    },
    async residents(_ctx) {
      return (await residentDefinitions()).map(({ name, description }) => ({ name, description }))
    },
    async standing(name, ctx) {
      const root = (await host.harness().conversation(ROOT_CONVERSATION_ID, ctx))!
      const main = await root.agent(ctx)
      const result = await host
        .harness()
        .commit(async (tx): Promise<{ id: ConversationId } | { missing: string[] }> => {
          const definitions = await residentDefinitions()
          const definition = definitions.find((item) => item.name === name)
          if (!definition) return { missing: definitions.map((item) => `@${item.name}`) }
          const index = await tx.doc(Standing, ROOT_CONVERSATION_ID)
          let id = Object.hasOwn(index, name) ? index[name] : undefined
          let created: ConversationRecord | undefined
          if (id === undefined || !(await tx.conversation(id))) {
            created = await tx.createConversation({ ownership: { kind: 'ownerless' } })
            id = created.id
            index[name] = id
          }
          const base = { ...main, ...(await hostDefault(host)) }
          await reconfigure(tx, id, definition, base, host.modelRuntime)
          await configure(tx, id, { cwd: host.projectRoot })
          Object.assign(await tx.doc(host.metadata, id), { label: 'agent', title: `@${name}` })
          await conversations.setAutomaticSummaries(tx, id, false)
          await conversations.setStanding(tx, id, true)
          setMark(await tx.doc(Marks, ROOT_CONVERSATION_ID), definition)
          if (created) await started(host, tx, created, name, 'standing')
          return { id }
        }, ctx)
      if ('missing' in result) {
        await pruneRetired(ctx)
        throw new Error(
          `Unknown standing agent @${name}. Standing agents: ${result.missing.join(', ') || 'none'}`,
        )
      }
      return result.id
    },
  }
  host.implement(SubagentsApi, service)
  const spawnDefinition = async (
    args: {
      agent?: string
      label?: string
      family?: string
      model?: string
      thinking?: ModelThinkingLevel
      tools?: string[]
      instructions?: string
    },
    definitions: AgentDefinition[],
  ): Promise<AgentDefinition> => {
    const named =
      args.agent === undefined ? undefined : definitions.find((d) => d.name === args.agent)
    if (!named && (args.agent !== undefined || !args.label?.trim()))
      throw new Error(
        `Unknown agent: ${args.agent}. Pass agent: one of ${definitions.map((agent) => agent.name).join(', ')}; or, for an agent made on the fly, label with family or model, tools and instructions`,
      )
    if (named && (args.tools || args.instructions))
      throw new Error('tools and instructions make an agent on the fly: leave out agent')
    const families = await readFamilies(host.userHome, host.projectRoot)
    if (args.family !== undefined && !Object.hasOwn(families.families, args.family))
      throw new Error(
        `Unknown family: ${args.family}. Families: ${Object.keys(families.families).join(', ')}`,
      )
    const pinned = args.model === undefined ? undefined : refOf(args.model)
    if (args.model !== undefined && !pinned?.modelId)
      throw new Error(`model must be provider/modelId, not ${args.model}`)
    const base: AgentDefinition = named ?? {
      name: args.label!.trim(),
      description: 'Made on the fly by subagent start',
      path: '',
      instructions: [ADHOC, args.instructions?.trim()].filter(Boolean).join('\n\n'),
      family: 'default',
      ...(args.tools ? { tools: args.tools } : {}),
      isolate: WRITE_TOOLS.some((tool) => !args.tools || args.tools.includes(tool))
        ? 'worktree'
        : 'none',
      summaries: false,
    }
    const explicitSelectionRequiresLogin =
      args.family !== undefined || pinned !== undefined || !named
    const definition = {
      ...base,
      ...(pinned ? { model: pinned } : args.family !== undefined ? { family: args.family } : {}),
      ...(args.thinking ? { thinking: args.thinking } : {}),
    }
    if (args.family !== undefined && !pinned) delete definition.model
    const runs = definitionRuns(definition, families)
    if (explicitSelectionRequiresLogin && runs.model && !previewModel()) {
      const available = host.modelRuntime.getAvailableSnapshot()
      if (!hasLogin(available, runs.model)) {
        const usable = Object.entries(families.families).flatMap(([name, spec]) => {
          const ref = refOf(spec.model)
          return !ref || hasLogin(available, ref)
            ? [`${name} (${spec.model ?? 'parent model'})`]
            : []
        })
        throw new Error(
          `No login for ${refName(runs.model)}${runs.via === 'family' ? ` (family ${runs.family})` : ''}. Usable families: ${usable.join(', ')}`,
        )
      }
    }
    return { ...definition, runs }
  }
  const Reporter = createReporter()
  let unsubscribe: (() => void) | undefined
  let recovery = Promise.resolve()
  const recoverUnreportedAnswer = async (submission: SubmissionRecord) => {
    if (
      submission.type !== 'input' ||
      submission.status !== 'done' ||
      submission.requestId?.startsWith('subagent:')
    )
      return
    await host.harness().commit(async (tx) => {
      const child = await tx.conversation(submission.conversationId)
      const parent = child?.owner?.conversationId
      if (parent === undefined) return
      const state = await tx.doc(Subagents, parent)
      const agent = state.agents[String(submission.conversationId)]
      if (!agent || agent.reported.includes(submission.answer)) return
      const childActions = Object.values(state.actions).filter(
        (candidate) => candidate.conversationId === submission.conversationId,
      )
      const input = await tx.entry(submission.entry)
      let parentMessageNeedsReporter =
        (MessageEntry.is(input) && input.data.from === parent && input.data.reply === false) ||
        (ReplyEntry.is(input) && input.data.from === parent)
      for (const action of childActions) {
        if (!parentMessageNeedsReporter || action.status !== undefined) continue
        const sibling = await tx.submissionByRequest(
          submission.conversationId,
          `subagent:${action.reporter}`,
        )
        if (sibling?.status === 'done' && sibling.answer === submission.answer)
          parentMessageNeedsReporter = false
      }
      if (!parentMessageNeedsReporter && !submission.requestId?.startsWith('watchdog-retry:')) {
        const action = childActions.at(-1)
        const interrupted = action?.status === 'interrupted'
        if (
          !action ||
          (!['unanswered', 'failed', 'given-up'].includes(action.status ?? '') && !interrupted)
        )
          return
        const failed = await tx.submissionByRequest(
          submission.conversationId,
          `subagent:${action.reporter}`,
        )
        const invalidContinuation =
          failed?.status !== 'unanswered' ||
          (failed.reason === 'aborted') !== interrupted ||
          (failed.entry === undefined && !interrupted)
        if (invalidContinuation) return
        const notNewerThanFailure = submission.entry <= (failed.entry ?? failed.id)
        if (notNewerThanFailure) return
      }
      const answer = (await tx.entry(AssistantEntry, submission.answer))?.model?.[0] as
        | AssistantMessage
        | undefined
      const reporter = await tx.createTask(
        Reporter,
        {
          conversationId: submission.conversationId,
          text: reportText(submission.conversationId, agent.agent, answer),
          steer: false,
          answer: submission.answer,
        },
        { conversationId: parent, ownership: { kind: 'conversation' }, background: true },
      )
      agent.reported.push(submission.answer)
      state.actions[`subagent-answer:${submission.answer}`] = {
        conversationId: submission.conversationId,
        reporter,
        answer: submission.answer,
        status: 'done',
      }
    }, BACKGROUND_CONTEXT)
  }
  host.onClose(async () => {
    unsubscribe?.()
    unsubscribe = undefined
    await recovery
  })
  host.onOpen(async () => {
    await pruneRetired(BACKGROUND_CONTEXT)
    for (const { name } of await residentDefinitions()) {
      const eagerResident = name !== 'ultimate'
      if (eagerResident)
        await service
          .standing(name, BACKGROUND_CONTEXT)
          .catch((error: unknown) => host.notice(`Standing agent @${name}: ${String(error)}`))
    }
    unsubscribe?.()
    unsubscribe = onCommit(host.harness(), (publication) => {
      for (const change of publication.changes) {
        if (change.type !== 'submission') continue
        recovery = recovery
          .then(() => recoverUnreportedAnswer(change.value))
          .catch((error: unknown) => {
            host.notice(`Subagent answer recovery failed: ${String(error)}`)
          })
      }
    })
    let cursor: Cursor | undefined
    do {
      const page = await host.scanSubmissions({ status: 'done' }, 500, cursor, BACKGROUND_CONTEXT)
      for (const submission of page.items) await recoverUnreportedAnswer(submission)
      cursor = page.next
    } while (cursor)
  })
  return defineExtension({
    name: 'subagents',
    tasks: [Anchor, Reporter],
    hooks: [
      hook(GenerationTask, {
        afterTools: async (_assistant, results, api, context) => {
          await host.harness().commit(async (tx) => {
            const answers = new Set<EntryId>()
            for (const id of results) {
              const message = (await tx.entry(ToolResultEntry, id))?.model?.[0]
              if (message?.role !== 'toolResult' || message.isError) continue
              const info = message.details as
                | { answerId?: EntryId; subagentAnswers?: EntryId[] }
                | undefined
              if (message.toolName === 'subagent' && info?.answerId !== undefined)
                answers.add(info.answerId)
              if (message.toolName === 'codemode')
                for (const answer of info?.subagentAnswers ?? []) answers.add(answer)
            }
            if (!answers.size) return
            const submissions = []
            for (const answer of answers)
              submissions.push({
                answer,
                submission: await tx.submissionByRequest(
                  api.conversationId,
                  reportRequestForAnswer(answer),
                ),
              })
            const queued = submissions.flatMap(({ submission }) =>
              submission?.status === 'queued' ? [submission.id] : [],
            )
            const inbox = await tx.doc(InboxDoc, api.conversationId)
            inbox.items = inbox.items.filter((item) => !queued.includes(item.id))
            for (const { answer, submission } of submissions) {
              const receiptMissing = !submission
              if (receiptMissing)
                await tx.createSubmission({
                  conversationId: api.conversationId,
                  requestId: reportRequestForAnswer(answer),
                  type: 'input',
                  status: 'unanswered',
                  reason: 'subagent-tool-delivered',
                })
              else if (submission.status === 'queued')
                tx.settleSubmission(submission.id, {
                  status: 'unanswered',
                  reason: 'subagent-tool-delivered',
                })
            }
          }, context)
        },
      }),
    ],
    sections: [
      section(
        'subagent_state',
        async (input, context) => {
          const state = await input.read.snapshot(Subagents, input.conversationId, context)
          const running: string[] = []
          const pending = new Set<ConversationId>()
          for (const action of Object.values(state?.actions ?? {}))
            if (
              action.status === undefined &&
              (await host.harness().getTask(action.reporter, context))?.state.status !== 'terminal'
            )
              pending.add(action.conversationId)
          const queued: string[] = []
          for (const agent of Object.values(state?.agents ?? {})) {
            const label = `${agent.conversationId} (${agent.agent})`
            if (
              (await input.read.snapshot(LiveDoc, agent.conversationId, context))?.run !== undefined
            )
              running.push(label)
            else if (pending.has(agent.conversationId)) queued.push(label)
          }
          const idlePromptSlot = ''
          if (!running.length && !queued.length) return idlePromptSlot
          const text = [
            ...(running.length ? [`Still running subagents: ${running.join(', ')}.`] : []),
            ...(queued.length ? [`Pending subagent inputs: ${queued.join(', ')}.`] : []),
            'A yielded wait is not a child answer. Use message, stop, or wait with these IDs; parent stop does not stop them. Queued inputs are delivered only at the normal boundary; do not act on them early.',
          ].join(' ')
          return `<subagent_state>\n${text}\n</subagent_state>`
        },
        { tag: false },
      ),
      section('subagents', async (input) => {
        const usesDefinitions = input.agent.tools.some((tool) =>
          ['subagent', 'branch', 'automation'].includes(tool.name),
        )
        if (!usesDefinitions) return undefined
        const discovered = await discoverAgents(
          host.ultimateRoot,
          host.projectRoot,
          host.userHome,
          host.modelRuntime,
        )
        const definitions = discovered.definitions
          .map((agent) => {
            const runs = runsLabel(agent.runs)
            return `${agent.name}${runs ? ` (${runs})` : ''}: ${agent.description}`
          })
          .join('\n')
        return `Available definitions:\n${definitions}`
      }),
    ],
    tools: [
      defineTool({
        name: 'subagent',
        description:
          'Delegate to a named agent. start returns its answer (foreground) or id (background). Foreground start/message and wait yield on queued steering with details.yielded:true; work continues independently. Stop children explicitly; stopping the parent does not stop them; stop lists files left uncommitted in the child worktree. message steers a busy child (steer false queues a follow-up instead); wait returns the latest answer; stop stops current work; list shows your children; land verifies and fast-forwards a finished worktree child; discard removes its worktree but keeps its branch. start accepts isolate none or worktree, and fork true to inherit parent history before this call (more context cost; prompt caching usually covers the shared prefix). Background answers join the current run after its tool round, or wake you when idle.',
        ...safeToRerun(
          'Call-id receipts deduplicate starts/messages; memoized targets and guards protect stop/workspace replays.',
        ),
        parameters: obj({
          action: strEnum(['start', 'message', 'wait', 'stop', 'list', 'land', 'discard']),
          agent: opt(
            str({
              description:
                'For start: an Available definitions name. Leave it out to make an agent on the fly from label, family or model, thinking, tools and instructions.',
            }),
          ),
          label: opt(
            str({
              description:
                'For start: what the child does, a few words ("dead-code scan"); the sidebar shows it. Required without agent.',
            }),
          ),
          family: opt(
            str({ description: 'For start: the model family to run on (fast, review…).' }),
          ),
          model: opt(str({ description: 'For start: provider/modelId, instead of a family.' })),
          thinking: opt(strEnum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])),
          tools: opt(
            arr(str(), {
              description:
                'Without agent: a subset of your tools (default: all but subagent). Leave out edit and write for a read-only agent; it runs in a worktree when it has either.',
            }),
          ),
          instructions: opt(
            str({
              description:
                'Without agent: its standing instructions, after a short neutral base; the task stays its first input.',
            }),
          ),
          task: opt(str()),
          background: opt(bool()),
          fork: opt(bool()),
          id: opt(int({ minimum: 1 })),
          text: opt(str()),
          steer: opt(bool()),
          isolate: opt(strEnum(['none', 'worktree'])),
        }),
        execute: async (args, api, context) => {
          const cached = await api.memo<ReturnType<typeof reply>>('result', context)
          if (cached) return cached
          const finish = (text: string, info?: ReturnType<typeof details>) =>
            api.memo('result', reply(text, info), context)
          const index = (await api.snapshot(Subagents, api.conversationId, context)) ?? {
            agents: {},
            actions: {},
          }
          if (args.action === 'list') {
            const rows = await Promise.all(
              Object.values(index.agents).map(async (agent) => ({
                ...agent,
                workspace: await workspaces.get(agent.conversationId, context),
                busy:
                  (await api.snapshot(LiveDoc, agent.conversationId, context))?.run !== undefined,
              })),
            )
            return finish(JSON.stringify(rows.map(({ reported: _reported, ...row }) => row)))
          }
          if (
            args.action !== 'start' &&
            (!args.id || !Object.hasOwn(index.agents, String(args.id)))
          )
            throw new Error('id must identify a child of this conversation')
          if (args.action === 'land' || args.action === 'discard') {
            if (await api.memo<boolean>('workspace-operation', context))
              throw new Error('Workspace operation interrupted; call again')
            await api.memo('workspace-operation', true, context)
            const operation = args.action
            return finish(
              JSON.stringify(await workspaces[operation](parseConversationId(args.id!), context)),
            )
          }
          if (args.action === 'start' || args.action === 'message') {
            const text = args.action === 'start' ? args.task : args.text
            if (!text?.trim())
              throw new Error(
                `${args.action} requires ${args.action === 'start' ? 'task' : 'text'}`,
              )
            const parent = await api.agent(context)
            const existingAction = index.actions[api.callId]
            const definitions =
              args.action === 'start' && !existingAction
                ? (
                    await discoverAgents(
                      host.ultimateRoot,
                      host.projectRoot,
                      host.userHome,
                      host.modelRuntime,
                    )
                  ).definitions
                : undefined
            const definition = definitions && (await spawnDefinition(args, definitions))
            if (definition?.tools?.some((name) => !parent.tools.some((tool) => tool.name === name)))
              throw new Error('Definition tools must be a subset of parent tools')
            const label = definition && (args.agent ? (args.label ?? definition.name) : args.label!)
            const isolated =
              definition && (args.isolate ?? definition.isolate ?? 'none') === 'worktree'
            const warning =
              isolated &&
              (await workspaces.git(parent.cwd ?? host.projectRoot, 'status', '--porcelain'))
                ? '\nWarning: parent has uncommitted changes; they are not in the worktree.'
                : ''
            const task = await api.getTask(api.taskId, context)
            // Pi upstream: @earendil-works/pi-durable@1.5.2 src/harness/tool.ts — internal ToolTaskInput.assistant locates the calling assistant. Drop when ToolExecutionApi exposes the calling assistant entry ID.
            const assistant = (task?.input as { assistant: EntryId } | undefined)?.assistant
            let historyBeforeAssistant: EntryId | undefined
            if (definition && args.fork) {
              const conversation = (await host.harness().conversation(api.conversationId, context))!
              const { entries } = await conversation.context(context)
              historyBeforeAssistant =
                entries[entries.findIndex((entry) => entry.id === assistant) - 1]?.id
              if (historyBeforeAssistant === undefined)
                throw new Error('No parent history before this call')
            }
            const model = definition ? await conversations.summaryModel() : undefined
            const action = await api.commit(async (tx) => {
              const state = await tx.doc(Subagents, api.conversationId)
              if (state.actions[api.callId]) return { ...state.actions[api.callId] }
              let conversationId: ConversationId
              if (definition) {
                await conversations.requestSummary(
                  tx,
                  api.conversationId,
                  { reason: 'spawn', answer: assistant!, agent: label!, task: text },
                  model,
                )
                const owner = await tx.createTask(Anchor, null, {
                  ownership: { kind: 'conversation' },
                  background: true,
                })
                const child = await createChild(host, tx, {
                  owner: { kind: 'task', taskId: owner },
                  definition,
                  parentAgent: parent,
                  modelRuntime: host.modelRuntime,
                  metadata: host.metadata,
                  label: label!,
                  title: shortTitle(text),
                  ...(args.agent ? {} : { adhoc: true as const }),
                  excludeTools: definition.tools?.includes('subagent') ? [] : ['subagent'],
                  excludeExtensions: definition.tools?.includes('subagent') ? [] : ['subagents'],
                  ...(historyBeforeAssistant === undefined
                    ? {}
                    : {
                        fork: {
                          conversationId: api.conversationId,
                          at: historyBeforeAssistant,
                        },
                      }),
                  cwd: parent.cwd ?? host.projectRoot,
                })
                conversationId = child.id
                await started(host, tx, child, label!, 'child')
                const runs = await tx.doc(Runs, ROOT_CONVERSATION_ID)
                const { model: ran } = await tx.doc(AgentDoc, child.id)
                runs[String(child.id)] = {
                  ...(ran ? { model: ran.modelId } : {}),
                  ...(args.agent ? { agent: definition.name } : { adhoc: true as const }),
                }
                state.agents[String(child.id)] = {
                  conversationId,
                  agent: label!,
                  background: args.background === true,
                  reported: [],
                }
                if (isolated) {
                  const workspace = await workspaces.create(
                    tx,
                    child.id,
                    parent.cwd ?? host.projectRoot,
                  )
                  await configure(tx, child.id, {
                    instructions: `${definition.instructions}\nWork only in ${workspace.path} on ${workspace.branch}, cut from ${workspace.base}. Commit your work on this branch with clear messages. Never push and never touch other checkouts.`,
                  })
                }
              } else conversationId = parseConversationId(args.id!)
              const reporter = await tx.createTask(
                Reporter,
                {
                  conversationId,
                  text,
                  steer: args.steer !== false,
                  ...(assistant ? { sourceEntry: assistant } : {}),
                },
                { ownership: { kind: 'conversation' }, background: true },
              )
              const createdAction = { conversationId, reporter }
              state.actions[api.callId] = createdAction
              return createdAction
            }, context)
            const isolate = await workspaces.get(action.conversationId, context)
            const isolateInfo = isolate
              ? `\nIsolate: ${isolate.path}\nBranch: ${isolate.branch}${warning}`
              : ''
            const background =
              index.agents[String(action.conversationId)]?.background ?? args.background === true
            const info = details(action.conversationId, background)
            await api.details(info, context)
            if (background)
              return finish(
                `Started ${args.action === 'message' ? 'message to' : 'subagent'} ${action.conversationId}.${isolateInfo}`,
                info,
              )
            if (
              !(await waitForChildLocally(
                api,
                action.conversationId,
                [action.reporter],
                false,
                context,
              ))
            )
              return finish(
                `Wait yielded for subagent ${action.conversationId}; work continues.${isolateInfo}`,
                details(action.conversationId, background, { yielded: true }),
              )
            const settled = (await api.snapshot(Subagents, api.conversationId, context))!.actions[
              api.callId
            ]
            const answer =
              settled.answer === undefined
                ? undefined
                : await api.commit((tx) => tx.entry(AssistantEntry, settled.answer!), context)
            return finish(
              (answer
                ? replyText(
                    action.conversationId,
                    answer.model?.[0] as AssistantMessage | undefined,
                  )
                : `Subagent ${action.conversationId}: ${settled.status}`) + isolateInfo,
              details(
                action.conversationId,
                background,
                settled.answer === undefined ? undefined : { answerId: settled.answer },
              ),
            )
          }
          const id = parseConversationId(args.id!)
          const info = details(id, index.agents[String(id)].background)
          await api.details(info, context)
          if (args.action === 'stop') {
            const live = await api.snapshot(LiveDoc, id, context)
            const state = await api.snapshot(Subagents, api.conversationId, context)
            const watchdogs = await api.commit(async (tx) => {
              const tasks = []
              let cursor: Cursor | undefined
              do {
                const page = await tx.scanTasks(
                  { conversationId: api.conversationId, kind: 'watchdog.failure' },
                  500,
                  cursor,
                )
                tasks.push(
                  ...page.items.filter(
                    (task) => (task.input as { conversation?: ConversationId }).conversation === id,
                  ),
                )
                cursor = page.next
              } while (cursor)
              return tasks.map((task) => ({
                task: task.id,
                request: `watchdog-retry:${(task.input as { failedTask: number }).failedTask}`,
              }))
            }, context)
            const capturedStopTarget = await api.memo(
              'stopTarget',
              {
                run: live?.run?.taskId ?? null,
                inputs: live?.run?.inputs ?? [],
                watchdogs,
                reporters: Object.values(state?.actions ?? {}).flatMap((action) =>
                  action.conversationId === id ? [action.reporter] : [],
                ),
              },
              context,
            )
            for (const reporter of [
              ...capturedStopTarget.reporters,
              ...capturedStopTarget.watchdogs.map((task) => task.task),
            ]) {
              await host.harness().abortTask(reporter, context)
              await api.waitForTask(reporter, context)
            }
            const submissions = await api.commit(async (tx) => {
              return Promise.all(
                [
                  ...capturedStopTarget.reporters.map((reporter) => `subagent:${reporter}`),
                  ...capturedStopTarget.watchdogs.map((task) => task.request),
                ].map((request) => tx.submissionByRequest(id, request)),
              )
            }, context)
            for (const submission of submissions)
              if (submission?.status === 'queued')
                await host.harness().abortSubmission(submission.id, context, id)
            const inputs = new Set([
              ...capturedStopTarget.inputs,
              ...submissions.flatMap((submission) => (submission ? [submission.id] : [])),
            ])
            while (true) {
              const run = (await api.snapshot(LiveDoc, id, context))?.run
              const outsideStopTarget =
                !run ||
                (run.taskId !== capturedStopTarget.run &&
                  !run.inputs.some((input) => inputs.has(input)))
              if (outsideStopTarget) break
              await host.harness().abortTask(run.taskId, context)
              await api.waitForTask(run.taskId, context)
            }
            const workspace = await workspaces.get(id, context)
            const untrimmedNulSeparatedPaths = (...command: string[]) =>
              exec('git', [...command, '-z'], {
                cwd: workspace!.path,
                maxBuffer: 1024 * 1024,
              }).then(({ stdout }) => stdout.split('\0').filter(Boolean))
            const uncommitted =
              workspace?.state === 'ready'
                ? [
                    ...new Set([
                      ...(await untrimmedNulSeparatedPaths('diff', '--cached', '--name-only')),
                      ...(await untrimmedNulSeparatedPaths('diff', '--name-only')),
                      ...(await untrimmedNulSeparatedPaths(
                        'ls-files',
                        '--others',
                        '--exclude-standard',
                      )),
                    ]),
                  ]
                : []
            return finish(
              `Stopped ${id}.${uncommitted.length ? `\nLeft uncommitted in ${workspace!.path}: ${uncommitted.join(', ')}` : ''}`,
              info,
            )
          }
          const reporters = Object.values(index.actions).flatMap((action) =>
            action.conversationId === id ? [action.reporter] : [],
          )
          if (!(await waitForChildLocally(api, id, reporters, true, context)))
            return finish(
              `Wait yielded for subagent ${id}; work continues.`,
              details(id, index.agents[String(id)].background, { yielded: true }),
            )
          const answer = await api.commit(async (tx) => {
            let cursor: Cursor | undefined
            let latest: EntryRecord | undefined
            do {
              const page = await tx.scanEntries({ conversationId: id }, 256, cursor)
              for (const entry of page.items)
                if (AssistantEntry.is(entry) && latest === undefined) latest = entry
              cursor = page.next
            } while (cursor !== undefined)
            if (!latest) return undefined
            const agent = (await tx.doc(Subagents, api.conversationId)).agents[String(id)]
            if (!agent.reported.includes(latest.id)) agent.reported.push(latest.id)
            return latest
          }, context)
          return finish(
            replyText(id, answer?.model?.[0] as AssistantMessage | undefined),
            details(
              id,
              index.agents[String(id)].background,
              answer === undefined ? undefined : { answerId: answer.id },
            ),
          )
        },
      }),
    ],
  })
}
