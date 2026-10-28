import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord'
import type { JsonValue } from '@earendil-works/chord'
import { Type } from '@earendil-works/pi-ai'
import type { AssistantMessage } from '@earendil-works/pi-ai'
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
import type {
  ConversationId,
  ConversationRecord,
  Cursor,
  EntryId,
  EntryRecord,
  TaskId,
  ToolExecutionApi,
  SubmissionRecord,
  Tx,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { Source } from '../../server/project.ts'
import {
  agentRoots,
  definitionAgent,
  deleteDefinition,
  discoverAgents,
  hostDefaultModel,
  saveDefinition,
  saveOverlay,
} from '../../lib/agents.ts'
import type { DefinitionFields } from '../../lib/agents.ts'
import { createChild, started } from './children.ts'
import { implementAction } from '../../lib/actions.ts'
import { exec } from '../../lib/exec.ts'
import { shortTitle } from '../../lib/title.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { Pin } from '../models/api.ts'
import { Profile, Standing, Subagents, SubagentsApi } from './api.ts'
import {
  DefinitionAction,
  DefinitionsAction,
  DeleteDefinitionAction,
  SaveDefinitionAction,
  StandingAction,
} from './refs.ts'

export const docs = [Subagents, Standing, Profile]
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
// A report is keyed by its answer, independently of the tool call that may return it.
const answerRequest = (answer: EntryId) => `subagent-answer:${answer}`
/** An aborted or failed turn keeps its partial message, often only an empty thinking block: not an answer. */
const answered = (message: AssistantMessage | undefined) =>
  message !== undefined &&
  message.stopReason !== 'aborted' &&
  message.stopReason !== 'error' &&
  textOf(message).trim() !== ''
const unanswered = (message: AssistantMessage | undefined) =>
  `ended its turn without an answer${message?.stopReason === 'aborted' || message?.stopReason === 'error' ? ` (${message.stopReason})` : ''}`
const answerText = (message: AssistantMessage | undefined) =>
  `Returned model: ${message?.provider && message?.model ? `${message.provider}/${message.model}` : 'unknown'}\n${textOf(message)}`
const reportText = (id: ConversationId, agent: string, message: AssistantMessage | undefined) =>
  answered(message)
    ? `[subagent ${id} (${agent}) answered] ${answerText(message)}`
    : `[subagent ${id} failed: ${unanswered(message)}]`
/** What a foreground start, message or wait returns for a child's answer entry. */
const replyText = (id: ConversationId, message: AssistantMessage | undefined) =>
  answered(message)
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
            // Provider failures belong to the watchdog, which marks the action `given-up` once it reports
            // instead of retrying. Either way recover() delivers the answer of a later watchdog retry (or
            // manual continuation).
            if (
              settled.status === 'unanswered' &&
              (settled.reason === 'model_error' || settled.reason === 'no_model')
            ) {
              action.status = 'failed'
              return { status: 'running', checkpoint: { phase: 'report' } }
            }
            if (settled.status === 'unanswered' && settled.reason !== 'aborted') {
              const failure = settled.reason
              return { status: 'running', checkpoint: { phase: 'report', report: failure } }
            }
            // A parent stop aborts this task before the input, so this abort came from the child's
            // own conversation: whatever answers its next input there still belongs to the parent.
            if (settled.status === 'unanswered') action.status = 'interrupted'
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
          const failed = !answered(message)
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
                answer === undefined ? `subagent-report:${task.id}` : answerRequest(answer),
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
        action.status = 'unanswered'
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, context),
  })
}

/** Details name the child and whether it answers in the background, for the call's renderer. */
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

/** Stop only these local waits; child and reporter ownership never changes. */
async function waitInterruptibly(
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
  inbox.start(async (value) => {
    inspect(value)
  })
  inspect(inbox.value)
  const child = (await api.conversation(id, context))!
  const ready = async () => {
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
        // Our reporter may have just queued the steer. Prefer its completed answer.
        if (await ready()) {
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

/** Extension-owned standing definitions retire when their extension is disabled live. */
export const reloadOnSettings = true

/** Browser actions for the Agents tab. */
export const actions = {
  /** `{name}`: open the current definition's standing conversation. */
  standing: implementAction(StandingAction, async (args, { host }) => {
    const { name } = (args ?? {}) as Record<string, JsonValue>
    if (typeof name !== 'string') throw new Error('name is required')
    return host.need(SubagentsApi).standing(name, BACKGROUND_CONTEXT)
  }),
  /**
   * The definitions without their instructions and the files that failed to parse, and for the config view the main
   * conversation's model and tools (a definition may list a subset), where each scope saves, and the project setup
   * decision, which the project scope needs.
   */
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
      scopes: {
        user: join(host.userHome, '.ultimate/agents'),
        project: join(host.projectRoot, '.ultimate/agents'),
      },
      projectSetup,
    }
  }),
  /** `{name}`: the definition that applies, its source and path, the raw file, and the scopes with a file of that name. */
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
    // A later file that fails to parse leaves an earlier one applying.
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
  /** `{name, scope, frontmatter, instructions}`: write `<scope>/agents/<name>.md`; invalid input writes nothing. */
  saveDefinition: implementAction(SaveDefinitionAction, async (args, { host }) => {
    const { name, scope, frontmatter, instructions, create } = (args ?? {}) as Record<
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
      isolate,
      resident,
      fast,
      summaries,
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
      ...(isolate ? { isolate } : {}),
      ...(resident !== undefined ? { resident } : {}),
      ...(fast ? { fast } : {}),
      ...(!summaries ? { summaries } : {}),
    }
    // The form shows the merged definition; a whole copy would freeze the overlays' additions and the base's
    // instructions, so the save becomes an overlay holding only what differs from the base.
    if (existing?.overlays?.length) {
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
  /** `{name, scope}`: remove a user or project definition; a built-in or user one of that name applies again. */
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
  // Core services, always on; each handle resolves the current provider at every call.
  const conversations = host.need(ConversationsApi)
  const workspaces = host.need(WorkspacesApi)
  const residentDefinitions = async () =>
    (
      await discoverAgents(host.ultimateRoot, host.projectRoot, host.userHome, host.modelRuntime)
    ).definitions.filter((definition) => definition.resident === true)
  /** Drops standing agents whose definition is gone; their conversations become ordinary ones. Retirement waits
   * until every definition parses: an error names a file, not the agent it defines, so a typo retires nothing. The
   * ones kept, every one while a definition fails to parse, get their automatic summaries turned off and stay
   * standing, as `standing` does on every refresh. */
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
      const index = await tx.doc(Standing, ROOT_CONVERSATION_ID)
      for (const name of Object.keys(index)) {
        const id = index[name]
        const exists = await tx.conversation(id)
        if (kept.has(name) || errors.length > 0) {
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
  // The definition a conversation runs as: children and standing agents record it, branches and the lander carry it
  // as a label. Its pin, read fresh, is what a conversation whose model lost its login switches to first.
  const definitionOf = async (tx: Tx, id: ConversationId) =>
    (await tx.doc(Profile, id)).definition ?? (await tx.doc(host.metadata, id)).label
  host.implement(Pin, {
    definitionOf,
    concludedIn: (tx) => conversations.concludedIn(tx),
    async pin(tx, id) {
      const name = await definitionOf(tx, id)
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
  host.implement(SubagentsApi, {
    async createChild(tx, options) {
      const child = await createChild(host, tx, options)
      await started(host, tx, child, options.definition?.name ?? options.label, 'child')
      return child
    },
    async residents(_ctx) {
      return (await residentDefinitions()).map(({ name, description }) => ({ name, description }))
    },
    async standing(name, ctx) {
      const definitions = await residentDefinitions()
      const definition = definitions.find((item) => item.name === name)
      if (!definition) {
        await pruneRetired(ctx)
        throw new Error(
          `Unknown standing agent @${name}. Standing agents: ${definitions.map((item) => `@${item.name}`).join(', ') || 'none'}`,
        )
      }
      const root = (await host.harness().conversation(ROOT_CONVERSATION_ID, ctx))!
      const main = await root.agent(ctx)
      return host.harness().commit(async (tx) => {
        const index = await tx.doc(Standing, ROOT_CONVERSATION_ID)
        let id = Object.hasOwn(index, name) ? index[name] : undefined
        let created: ConversationRecord | undefined
        // A new conversation starts on the default model; an existing one keeps the model and thinking level chosen
        // in it, so a refresh changes them only where the definition pins them.
        let base = { ...main, model: await hostDefaultModel(host) }
        if (id !== undefined && (await tx.conversation(id))) {
          const own = await tx.doc(AgentDoc, id)
          base = {
            ...main,
            model: own.model ?? base.model,
            thinkingLevel: own.thinkingLevel ?? main.thinkingLevel,
          }
        } else {
          created = await tx.createConversation({ ownership: { kind: 'ownerless' } })
          id = created.id
          index[name] = id
        }
        const change = definitionAgent(definition, base, host.modelRuntime)
        await configure(tx, id, { ...change, cwd: host.projectRoot })
        Object.assign(await tx.doc(host.metadata, id), { label: 'agent', title: `@${name}` })
        // A standing agent keeps its `@name`: no automatic title, summary or reply activity.
        await conversations.setAutomaticSummaries(tx, id, false)
        await conversations.setStanding(tx, id, true)
        ;(await tx.doc(Profile, id)).definition = name
        // Only a new conversation starts: a refresh reconfigures one that already runs.
        if (created) await started(host, tx, created, name, 'standing')
        return id
      }, ctx)
    },
  })
  const Reporter = createReporter()
  let unsubscribe: (() => void) | undefined
  let recovery = Promise.resolve()
  const recover = async (submission: SubmissionRecord) => {
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
      // A one-way message from the parent, or its reply to the child's own question, has no
      // reporter and no reply: without this, the answer it starts never reaches the parent,
      // which stays idle. A pending reporter whose input was answered in the same run delivers
      // that answer itself.
      const input = await tx.entry(submission.entry)
      const message = input?.data as { from?: unknown; reply?: unknown } | undefined
      let messaged =
        message?.from === parent &&
        ((input?.kind === 'board.message' && message.reply === false) ||
          input?.kind === 'board.reply')
      for (const action of childActions) {
        if (!messaged || action.status !== undefined) continue
        const sibling = await tx.submissionByRequest(
          submission.conversationId,
          `subagent:${action.reporter}`,
        )
        if (sibling?.status === 'done' && sibling.answer === submission.answer) messaged = false
      }
      // Watchdog continuations also answer failed one-way messages, which have no reporter action.
      if (!messaged && !submission.requestId?.startsWith('watchdog-retry:')) {
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
        // IDs share one allocation order; an input withdrawn before placement has no entry.
        if (
          failed?.status !== 'unanswered' ||
          (failed.reason === 'aborted') !== interrupted ||
          (failed.entry === undefined && !interrupted) ||
          submission.entry <= (failed.entry ?? failed.id)
        )
          return
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
    unsubscribe?.()
    // Not a reactor: subagent answers settle as Pi submission records, not domain events.
    unsubscribe = host.harness().subscribeCommits((publication) => {
      for (const change of publication.changes) {
        if (change.type !== 'submission') continue
        recovery = recovery
          .then(() => recover(change.value))
          .catch((error: unknown) => {
            host.notice(`Subagent answer recovery failed: ${String(error)}`)
          })
      }
    })
    let cursor: Cursor | undefined
    do {
      const page = await host.scanSubmissions({ status: 'done' }, 500, cursor, BACKGROUND_CONTEXT)
      for (const submission of page.items) await recover(submission)
      cursor = page.next
    } while (cursor)
  })
  return defineExtension({
    name: 'subagents',
    tasks: [Anchor, Reporter],
    hooks: [
      hook(GenerationTask, {
        afterTools: async (_assistant, results, api, context) => {
          // Tool settlement is not a receipt. Only committed outer results may acknowledge.
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
                submission: await tx.submissionByRequest(api.conversationId, answerRequest(answer)),
              })
            const queued = submissions.flatMap(({ submission }) =>
              submission?.status === 'queued' ? [submission.id] : [],
            )
            const inbox = await tx.doc(InboxDoc, api.conversationId)
            inbox.items = inbox.items.filter((item) => !queued.includes(item.id))
            for (const { answer, submission } of submissions) {
              // A reporter not yet submitted must also see this receipt through request deduplication.
              if (!submission)
                await tx.createSubmission({
                  conversationId: api.conversationId,
                  requestId: answerRequest(answer),
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
      section('subagent_state', async (input, context) => {
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
        if (!running.length && !queued.length) return undefined
        return [
          ...(running.length ? [`Still running subagents: ${running.join(', ')}.`] : []),
          ...(queued.length ? [`Pending subagent inputs: ${queued.join(', ')}.`] : []),
          'A yielded wait is not a child answer. Use message, stop, or wait with these IDs; parent stop does not stop them. Queued inputs are delivered only at the normal boundary; do not act on them early.',
        ].join(' ')
      }),
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
          .map((agent) => `${agent.name}: ${agent.description}`)
          .join('\n')
        return `Available definitions:\n${definitions}`
      }),
    ],
    tools: [
      defineTool({
        name: 'subagent',
        description:
          'Delegate to a named agent. start returns its answer (foreground) or id (background). Foreground start/message and wait yield on queued steering with details.yielded:true; work continues independently. Stop children explicitly; stopping the parent does not stop them; stop lists files left uncommitted in the child worktree. message steers a busy child (steer false queues a follow-up instead); wait returns the latest answer; stop stops current work; list shows your children; land verifies and fast-forwards a finished worktree child; discard removes its worktree but keeps its branch. start accepts isolate none or worktree, and fork true to inherit parent history before this call (more context cost; prompt caching usually covers the shared prefix). Background answers join the current run after its tool round, or wake you when idle.',
        // Call-id receipts deduplicate starts/messages; memoized targets and guards protect stop/workspace replays.
        replay: 'safe',
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal('start'),
            Type.Literal('message'),
            Type.Literal('wait'),
            Type.Literal('stop'),
            Type.Literal('list'),
            Type.Literal('land'),
            Type.Literal('discard'),
          ]),
          agent: Type.Optional(
            Type.String({ description: 'Required for start: an Available definitions name.' }),
          ),
          task: Type.Optional(Type.String()),
          background: Type.Optional(Type.Boolean()),
          fork: Type.Optional(Type.Boolean()),
          id: Type.Optional(Type.Integer({ minimum: 1 })),
          text: Type.Optional(Type.String()),
          steer: Type.Optional(Type.Boolean()),
          isolate: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('worktree')])),
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
              JSON.stringify(await workspaces[operation](args.id as ConversationId, context)),
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
            const definition = definitions?.find((agent) => agent.name === args.agent)
            if (definitions && !definition)
              throw new Error(
                `Unknown agent: ${args.agent}. Pass agent: one of ${definitions.map((agent) => agent.name).join(', ')}`,
              )
            if (definition?.tools?.some((name) => !parent.tools.some((tool) => tool.name === name)))
              throw new Error('Definition tools must be a subset of parent tools')
            const isolated =
              definition && (args.isolate ?? definition.isolate ?? 'none') === 'worktree'
            const warning =
              isolated &&
              (await workspaces.git(parent.cwd ?? host.projectRoot, 'status', '--porcelain'))
                ? '\nWarning: parent has uncommitted changes; they are not in the worktree.'
                : ''
            const task = await api.getTask(api.taskId, context)
            // Pi upstream: @earendil-works/pi-durable@1.4.0 src/harness/tool.ts — internal ToolTaskInput.assistant locates the calling assistant. Drop when ToolExecutionApi exposes the calling assistant entry ID.
            const assistant = (task?.input as { assistant: EntryId } | undefined)?.assistant
            let forkAt: EntryId | undefined
            if (definition && args.fork) {
              const conversation = (await host.harness().conversation(api.conversationId, context))!
              const view = await conversation.viewState(context)
              try {
                const position = view.value.entries.findIndex((entry) => entry.id === assistant)
                forkAt = view.value.entries[position - 1]?.id
                if (forkAt === undefined) throw new Error('No parent history before this call')
              } finally {
                view.dispose()
              }
            }
            const model = definition ? await conversations.summaryModel() : undefined
            const action = await api.commit(async (tx) => {
              const state = await tx.doc(Subagents, api.conversationId)
              if (state.actions[api.callId]) return { ...state.actions[api.callId] }
              let conversationId = args.id as ConversationId
              if (definition) {
                await conversations.requestSummary(
                  tx,
                  api.conversationId,
                  { reason: 'spawn', answer: assistant!, agent: definition.name, task: text },
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
                  label: definition.name,
                  title: shortTitle(text),
                  excludeTools: definition.tools?.includes('subagent') ? [] : ['subagent'],
                  excludeExtensions: definition.tools?.includes('subagent') ? [] : ['subagents'],
                  ...(forkAt === undefined
                    ? {}
                    : { fork: { conversationId: api.conversationId, at: forkAt } }),
                  cwd: parent.cwd ?? host.projectRoot,
                })
                conversationId = child.id
                await started(host, tx, child, definition.name, 'child')
                state.agents[String(child.id)] = {
                  conversationId,
                  agent: definition.name,
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
              }
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
              !(await waitInterruptibly(
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
          const id = args.id as ConversationId
          const info = details(id, index.agents[String(id)].background)
          await api.details(info, context)
          if (args.action === 'stop') {
            // Capture identities before cancellation; replay must leave later reuse alone.
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
                    (task) => (task.input as { conversation?: number }).conversation === id,
                  ),
                )
                cursor = page.next
              } while (cursor)
              return tasks.map((task) => ({
                task: task.id,
                request: `watchdog-retry:${(task.input as { failedTask: number }).failedTask}`,
              }))
            }, context)
            const target = await api.memo(
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
            // Join delivery invocations before inspecting admissions that may have raced stop.
            // Capture watchdog identities too: Stop must not restart the child after its delay.
            for (const reporter of [
              ...target.reporters,
              ...target.watchdogs.map((task) => task.task),
            ]) {
              await host.harness().abortTask(reporter, context)
              await api.waitForTask(reporter, context)
            }
            const submissions = await api.commit(async (tx) => {
              return Promise.all(
                [
                  ...target.reporters.map((reporter) => `subagent:${reporter}`),
                  ...target.watchdogs.map((task) => task.request),
                ].map((request) => tx.submissionByRequest(id, request)),
              )
            }, context)
            for (const submission of submissions)
              if (submission?.status === 'queued')
                await host.harness().abortSubmission(submission.id, context, id)
            const inputs = new Set([
              ...target.inputs,
              ...submissions.flatMap((submission) => (submission ? [submission.id] : [])),
            ])
            // A tool round can hand off between the snapshot and abort; follow only captured inputs.
            while (true) {
              const run = (await api.snapshot(LiveDoc, id, context))?.run
              if (
                !run ||
                (run.taskId !== target.run && !run.inputs.some((input) => inputs.has(input)))
              )
                break
              await host.harness().abortTask(run.taskId, context)
              await api.waitForTask(run.taskId, context)
            }
            // Report, never commit or delete: the coordinator decides what happens to the work.
            const workspace = await workspaces.get(id, context)
            // Untrimmed NUL-separated name lists: the git helper in lib/ trims, which would cut a
            // leading space off the first name.
            const list = (...command: string[]) =>
              exec('git', [...command, '-z'], {
                cwd: workspace!.path,
                maxBuffer: 1024 * 1024,
              }).then(({ stdout }) => stdout.split('\0').filter(Boolean))
            const uncommitted =
              workspace?.state === 'ready'
                ? [
                    ...new Set([
                      ...(await list('diff', '--cached', '--name-only')),
                      ...(await list('diff', '--name-only')),
                      ...(await list('ls-files', '--others', '--exclude-standard')),
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
          if (!(await waitInterruptibly(api, id, reporters, true, context)))
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
