import { offsetEntryId } from '../../lib/ids.shared.ts'
import type {
  ConversationId,
  Cursor,
  HookApi,
  JsonObject,
  TaskId,
  ToolExecutionResult,
  ToolHookCall,
  Tx,
} from '@earendil-works/pi-durable'
import { withAbortSignal } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import { obj, opt, str, unknown, bool } from '@earendil-works/pi-schema'
import {
  CODEMODE_OPTIONS_PREFIX,
  CodemodeSandbox,
  parseCodemodeSource,
  renderDeclarations,
} from '@earendil-works/pi-codemode'
import { CodemodeStoreDoc, createCodemodeExtension } from '@earendil-works/pi-durable/codemode'
import type { CodemodeGlobal, CodemodeToolDetails } from '@earendil-works/pi-durable/codemode'
import {
  AgentDoc,
  InboxDoc,
  LiveDoc,
  UsageDoc,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  hook,
  ROOT_CONVERSATION_ID,
  section,
  ToolTask,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { discoverAgents } from '../../lib/agents.ts'
import { shortTitle } from '../../lib/title.ts'
import { safeToRerun } from '../../lib/replay.ts'
import { apiSource, apiSummaries } from '../../lib/api-files.ts'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ActionContext } from '../../server/actions.ts'
import { READS, readProject } from './projects.ts'
import { REMOTE_BYTES } from '../../lib/remote.ts'
import type { Read } from './projects.ts'
import { closedChapter, compactEntry, id, limit, readChapter, searchHit } from './chapters.ts'
import type { EntriesOptions, HistoryRead, SearchOptions } from './chapters.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { MessagesApi } from '../messages/api.ts'
import type { ResponseReceipt } from '../conversations/summary.ts'
import type { SummaryModel } from '../conversations/summary-model.ts'
import { Summarized } from './refs.ts'
import type { CallSummary } from './refs.ts'
import { PendingDoc, SummaryDoc } from './api.ts'
import {
  fixedLine,
  parseSummary,
  SCRIPT_FAILED,
  SUMMARY_SYSTEM,
  summaryCalls,
  summaryInput,
} from './summary.ts'
import type { Call } from './summary.ts'
import { MAX_MODEL_CALLS, modelCallLimits } from './models.ts'
import { checkpointEvery } from '../../shared/checkpoint.ts'

const RetiredStore = defineDoc({
  kind: 'codemode.store',
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  fork: 'asOf',
  history: 'rewindable',
  initial: (): JsonObject => ({}),
})
const StoreCopied = defineDoc({
  kind: 'codemode.store-copied',
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'asOf',
  initial: (): { copied: boolean } => ({ copied: false }),
})
const KEPT_SUMMARY_LIMIT = 1000
export { SummaryDoc }
export const docs = [CodemodeStoreDoc, SummaryDoc, PendingDoc]
const terminal = { status: 'terminal', outcome: { status: 'completed', result: null } } as const

function localReads(host: ExtensionHost, context: Context) {
  const conversations = () =>
    host.harness().commit(async (tx) => {
      const items = []
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanConversations({}, 100, cursor)
        items.push(...page.items)
        cursor = page.next
      } while (cursor)
      return items
    }, context)
  const entries = async (conversation: unknown, options: EntriesOptions = {}) => {
    const found = await host.harness().conversation(id(conversation), context)
    if (!found) throw new Error('Unknown conversation')
    const items: unknown[] = []
    let cursor: Cursor | undefined
    const count = limit(options.limit)
    do {
      const page = await found.entries(
        options.before === undefined
          ? {}
          : {
              maxEntryId: offsetEntryId(options.before, -1),
            },
        100,
        cursor,
        context,
      )
      for (const entry of page.items) {
        if (!options.kinds || options.kinds.includes(entry.kind))
          items.push(options.full ? entry : compactEntry(entry))
        if (items.length === count) return items
      }
      cursor = page.next
    } while (cursor)
    return items
  }
  const search = async (text: unknown, options: SearchOptions = {}) => {
    if (typeof text !== 'string' || !text) throw new Error('search text must be nonempty')
    const count = limit(options.limit)
    const records =
      options.conversationId === undefined
        ? await conversations()
        : [{ id: id(options.conversationId) }]
    const matches: unknown[] = []
    for (const conversation of records) {
      let cursor: Cursor | undefined
      do {
        const found = await host.harness().conversation(conversation.id, context)
        if (!found) throw new Error('Unknown conversation')
        const page = await found.entries({}, 100, cursor, context)
        for (const entry of page.items) {
          const hit = searchHit(entry, text, options)
          if (hit) matches.push(hit)
          if (matches.length === count) return matches
        }
        cursor = page.next
      } while (cursor)
    }
    return matches
  }
  const listed = async () => {
    const summaries = new Map(host.conversations().map((summary) => [summary.id, summary]))
    const concluded = (await host.uiState(context))['ext.conversations.concluded']
    const done = new Set(Array.isArray(concluded) ? concluded : [])
    return (await conversations()).map((record) => {
      const summary = summaries.get(record.id)
      return {
        ...record,
        ...(summary && {
          title: summary.title === undefined ? undefined : shortTitle(summary.title),
          label: summary.label,
          cwd: summary.cwd,
          busy: summary.busy,
          inputAt: summary.inputAt,
        }),
        ...(done.has(record.id) && { concluded: true }),
      }
    })
  }
  const history =
    (op: HistoryRead, at: number, live: (args: unknown[]) => unknown) =>
    async (args: unknown[]) => {
      const database = await closedChapter(host.home, host.chapter.name, args[at])
      return database ? readChapter(database, op, args) : live(args)
    }
  return {
    conversations: history('conversations', 0, () => listed()),
    entries: history('entries', 1, ([conversation, options]) =>
      entries(conversation, options as EntriesOptions),
    ),
    search: history('search', 1, ([text, options]) => search(text, options as SearchOptions)),
    trace: ([query]) => host.trace.query(query ?? {}),
    traceTree: ([traceId]) => {
      if (typeof traceId !== 'string' || !traceId) throw new Error('traceId must be nonempty')
      return host.trace.tree(traceId)
    },
    doc: async ([kind, conversation]) => {
      const token =
        host.doc(kind as string) ??
        [AgentDoc, InboxDoc, LiveDoc, UsageDoc].find((doc) => doc.definition.kind === kind)
      if (!token) throw new Error(`Unknown conversation document: ${String(kind)}`)
      const snapshot = await host.harness().snapshot(token, id(conversation), context)
      return snapshot ?? token.definition.initial()
    },
  } satisfies Record<Read, (args: unknown[]) => unknown>
}

type Helper = {
  name: string
  description: string
  signature: string
  execute(args: unknown[], conversationId: ConversationId, context: Context): unknown
}

function helpers(host: ExtensionHost): Helper[] {
  const remoteMachine = (machine: unknown) => {
    if (machine !== undefined && (typeof machine !== 'string' || !machine))
      throw new Error('machine must be nonempty')
    return machine
  }
  const read =
    (op: Read, at: number): Helper['execute'] =>
    async (values, _conversation, context) => {
      const args = [...values]
      const options = args[at]
      const project =
        options && typeof options === 'object' && 'project' in options ? options.project : undefined
      if (project !== undefined) {
        if (
          options &&
          typeof options === 'object' &&
          'chapter' in options &&
          options.chapter !== undefined
        )
          throw new Error('chapter and project cannot be used together')
        if (typeof project !== 'string' || !project) throw new Error('project must be nonempty')
        const { project: _project, machine, ...rest } = options as Record<string, unknown>
        args[at] = rest
        const remote = await readProject(
          host,
          { project, machine: remoteMachine(machine) },
          op,
          args as JsonValue[],
          context.abortSignal,
        )
        if (remote) return remote.value
      }
      return localReads(host, context)[op](args)
    }
  return [
    {
      name: 'system',
      description: 'Current machine, process, persistence, resources and build identity.',
      signature: '(): Promise<unknown>',
      execute: () => host.system(),
    },
    {
      name: 'projects',
      description: 'Project folders, JSON conversation summaries and URLs of running instances.',
      signature: '(): Promise<unknown[]>',
      execute: () => host.projects(),
    },
    {
      name: 'uiState',
      description: 'Durable UI state of the root conversation: what the user is looking at.',
      signature: '(): Promise<unknown>',
      execute: (_args, _conversation, context) => host.uiState(context),
    },
    {
      name: 'extensions',
      description: 'Extension folders, facets, tools, documents and retained load errors.',
      signature: '(): Promise<unknown[]>',
      execute: () => host.extensions(),
    },
    {
      name: 'catalogue',
      description:
        'Extension APIs: who provides, needs and wants each, plus missing providers and dependency cycles.',
      signature:
        '(): Promise<{ apis: { name: string; provider?: string; needs: string[]; wants: string[] }[]; missing: string[]; cycles: string[][] }>',
      execute: () => host.catalogue(),
    },
    {
      name: 'apis',
      description:
        'Extension contracts: each enabled extension with an api.ts or refs.ts and the one-line summary of what it offers.',
      signature: '(): Promise<{ name: string; summary: string }[]>',
      execute: () => apiSummaries(host.extensions()),
    },
    {
      name: 'api',
      description:
        "The contract of one extension: its api.ts (services, documents) and refs.ts (documents, actions with their arguments and results, events), each under a header line. Read it before calling the extension's actions.",
      signature: '(name: string): Promise<string>',
      execute: ([name]) => {
        if (typeof name !== 'string' || !name) throw new Error('name must be nonempty')
        return apiSource(host.extensions(), name)
      },
    },
    {
      name: 'trace',
      description:
        'Recorded calls (service, action, reactor, tool, model), oldest first (default `limit` 100, at most 1000): filter by trace id, conversation, or ISO `since`/`until`. With `since`, reads the oldest `limit` calls after `since` (up to `until`); otherwise the newest `limit` calls (before `until`).',
      signature:
        '(query?: { trace?: string; conversation?: number; since?: string; until?: string; limit?: number; project?: string; machine?: string }): Promise<{ id: string; parent?: string; trace: string; at: string; ms: number; caller: string; callee: string; kind: string; name: string; ok: boolean; error?: string; args?: string; result?: string; conversation?: number; task?: number; entry?: number }[]>',
      execute: read('trace', 0),
    },
    {
      name: 'traceTree',
      description:
        'The calls of one trace nested under their parents (`children`), in start order.',
      signature:
        '(traceId: string, options?: { project?: string; machine?: string }): Promise<unknown[]>',
      execute: read('traceTree', 1),
    },
    {
      name: 'conversations',
      description:
        'All stored conversations: id, owner, and for listed ones title, label, cwd, busy, inputAt and concluded. chapter reads another chapter read-only (not with project); cross-chapter links are written <chapter>#123.',
      signature:
        '(options?: { project?: string; machine?: string; chapter?: string }): Promise<unknown[]>',
      execute: read('conversations', 0),
    },
    {
      name: 'entries',
      description:
        'Newest-first fork-aware stored history, including before resets and compactions. before is an exclusive entry ID. Entries are compact: message text whole, tool results kept at start and end, args and data cut, no thinking; full returns stored entries.',
      signature:
        '(conversationId: number, options?: { kinds?: string[]; limit?: number; before?: number; full?: boolean; project?: string; machine?: string; chapter?: string }): Promise<{ id: number; kind: string; at?: string; role?: string; tool?: string; text?: string; tools?: { name: string; args: string }[]; stopReason?: string; error?: string | true; data?: string }[]>',
      execute: read('entries', 1),
    },
    {
      name: 'search',
      description:
        'Case-sensitive substring search over all stored entry JSON, including history before resets and compactions. kinds keeps only those entry kinds. Hits are compact, about 200 characters of the entry JSON around the match; full returns whole entries, or read one with entries(conversation, {before: id + 1, limit: 1}).',
      signature:
        '(text: string, options?: { conversationId?: number; kinds?: string[]; limit?: number; full?: boolean; project?: string; machine?: string; chapter?: string }): Promise<{ conversation: number; id: number; kind: string; at?: string; excerpt: string }[]>',
      execute: read('search', 1),
    },
    {
      name: 'taskGraph',
      description: 'Live durable tasks and ownership graph.',
      signature: '(): Promise<unknown>',
      execute: async (_args, _conversation, context) => {
        const graph = await host.harness().watchTaskGraph(context)
        await graph.stop()
        return graph.value
      },
    },
    {
      name: 'models',
      description: 'Model metadata (no credentials or provider headers).',
      signature: '(): Promise<unknown[]>',
      execute: () => host.models(),
    },
    {
      name: 'agents',
      description:
        "Agent definitions for subagents and automations, the files that failed to parse, user or project files replacing a built-in, and the project's `.ultimate/` setup decision: its definitions apply only once trusted. To change one, edit its file.",
      signature:
        "(): Promise<{ definitions: { name: string; description: string; path: string; source: 'builtin' | 'user' | 'project'; instructions: string; model?: { provider: string; modelId: string }; thinking?: string; tools?: string[]; isolate?: 'none' | 'worktree'; resident?: boolean; fast?: boolean; summaries?: boolean; overlays?: string[] }[]; errors: { name: string; path: string; source: string; error: string }[]; replaced: { name: string; path: string; source: string }[]; projectSetup: 'trusted' | 'declined' | 'undecided' }>",
      execute: () =>
        discoverAgents(host.ultimateRoot, host.projectRoot, host.userHome, host.modelRuntime),
    },
    {
      name: 'doc',
      description:
        'Read an exported extension document or pi.agent, pi.inbox, pi.live or pi.usage by kind; defaults to this conversation, or to conversation 1 in another project.',
      signature:
        '(kind: string, conversationId?: number, options?: { project?: string; machine?: string }): Promise<unknown>',
      execute: async ([kind, conversation, options], conversationId, context) => {
        const project =
          options && typeof options === 'object' && 'project' in options
            ? options.project
            : undefined
        if (project !== undefined) {
          if (typeof project !== 'string' || !project) throw new Error('project must be nonempty')
          const args = [kind, conversation ?? ROOT_CONVERSATION_ID] as JsonValue[]
          const machine = remoteMachine((options as Record<string, unknown>).machine)
          const remote = await readProject(
            host,
            { project, machine },
            'doc',
            args,
            context.abortSignal,
          )
          if (remote) return remote.value
        }
        return localReads(host, context).doc([kind, conversation ?? conversationId])
      },
    },
  ]
}

const asJson = (value: unknown) =>
  value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as JsonValue)

export const actions = {
  async read(input: JsonValue, { host, signal }: ActionContext) {
    const { op, args } = (input ?? {}) as { op?: unknown; args?: unknown }
    if (!READS.includes(op as Read)) throw new Error(`op must be one of ${READS.join(', ')}`)
    if (args !== undefined && !Array.isArray(args)) throw new Error('args must be an array')
    const value = await localReads(host, withAbortSignal(signal, BACKGROUND_CONTEXT))[op as Read](
      args ?? [],
    )
    const result = asJson(value) ?? null
    if (Buffer.byteLength(JSON.stringify(result)) > REMOTE_BYTES)
      throw new Error('The answer is larger than 1 MiB; ask for a smaller limit')
    return result
  },
}

const DEFAULT_TIMEOUT_MS = 60_000
export function withDefaultTimeout(code: string) {
  let parsed: ReturnType<typeof parseCodemodeSource>
  try {
    parsed = parseCodemodeSource(code)
  } catch {
    return code
  }
  if (parsed.options.timeoutMs !== undefined) return code
  const options = {
    ...(parsed.options.maxOutputTokens === undefined
      ? {}
      : { max_output_tokens: parsed.options.maxOutputTokens }),
    timeout_ms: DEFAULT_TIMEOUT_MS,
  }
  const line = `${CODEMODE_OPTIONS_PREFIX} ${JSON.stringify(options)}`
  return parsed.code.startsWith('\n') ? `${line}${parsed.code}` : `${line}\n${parsed.code}`
}

export default function codemode(host: ExtensionHost) {
  const sandbox = host.resource('codemode.sandbox', () => {
    const created = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 })
    host.onClose(() => created.close())
    return created
  })
  const ultimateHelpers = helpers(host)
  const helperCallsByTask = new Map<TaskId, Call[]>()
  const globals: CodemodeGlobal[] = ultimateHelpers.map((helper) => ({
    name: `ultimate.${helper.name}`,
    spread: true,
    execute: async (args, api, context) => {
      const values = Array.isArray(args) ? args : []
      const record = (status: string) =>
        helperCallsByTask
          .get(api.taskId)
          ?.push({ name: `ultimate.${helper.name}`, args: values, status })
      try {
        const value = asJson(await helper.execute(values, api.conversationId, context)) ?? null
        record('ok')
        return value
      } catch (error) {
        if (!context.abortSignal?.aborted) record('error')
        throw error
      }
    },
  }))
  const declarations = renderDeclarations({
    globals: ultimateHelpers.map((helper) => ({
      name: `ultimate.${helper.name}`,
      description: helper.description,
      signature: helper.signature,
      spread: true,
      execute: () => undefined,
    })),
  })
  // Pi upstream: @earendil-works/pi-durable@1.6.0 src/codemode/codemode.ts — CodemodeToolOptions.globals is @internal. Drop when Pi exports host globals for code mode.
  const pi = createCodemodeExtension({ sandbox, models: true, globals })
  const piSection = pi.sections![0]
  const actionTool = defineTool({
    name: 'action',
    description:
      "Call an extension action, as the UI does, on behalf of this conversation; ultimate.extensions() lists each extension's actions, ultimate.api(name) their arguments.",
    parameters: obj({ extension: str(), action: str(), args: opt(unknown()) }),
    structuredOutputSchema: unknown(),
    callers: ['tools'],
    replay: 'unsafe',
    async execute({ extension, action, args }, api, context) {
      const value = await host.invoke(
        extension,
        action,
        (args ?? null) as JsonValue,
        context.abortSignal!,
        api.conversationId,
      )
      return {
        output: [{ type: 'text', text: JSON.stringify(value) ?? 'null' }],
        structuredOutput: asJson(value) ?? null,
      }
    },
  })
  const tellTool = defineTool({
    name: 'tell',
    description:
      "Message another project's @ultimate (only @ultimate reaches it, as a message from you, never the user), as @ultimate only; with reply (default true) its answer returns to you as a reply. machine picks one instance when the project runs on several.",
    parameters: obj({
      project: str({ minLength: 1 }),
      text: str({ minLength: 1 }),
      reply: opt(bool()),
      machine: opt(str({ minLength: 1 })),
    }),
    structuredOutputSchema: unknown(),
    callers: ['tools'],
    replay: 'unsafe',
    async execute({ project, text, reply, machine }, api, context) {
      const sent = await host.need(MessagesApi).tell(
        api.conversationId,
        {
          project,
          text,
          ...(reply === undefined ? {} : { reply }),
          ...(machine ? { machine } : {}),
        },
        context,
      )
      return { output: [{ type: 'text', text: JSON.stringify(sent) }], structuredOutput: sent }
    },
  })
  const copyRetiredStoreOnce = (api: HookApi, context: Context) =>
    host.harness().commit(async (tx) => {
      const marker = await tx.doc(StoreCopied, api.conversationId)
      if (marker.copied) return
      marker.copied = true
      const old = await tx.doc(RetiredStore, api.conversationId)
      if (!Object.keys(old).length) return
      const store = await tx.doc(CodemodeStoreDoc, api.conversationId)
      for (const [key, value] of Object.entries(old))
        if (!Object.hasOwn(store.values, key)) store.values[key] = value
    }, context)
  const summarize = async (api: HookApi, call: ToolHookCall, result: ToolExecutionResult) => {
    const details = result.details as CodemodeToolDetails | undefined
    const helperCalls = helperCallsByTask.get(api.taskId)
    helperCallsByTask.delete(api.taskId)
    const calls = [...(helperCalls ?? []), ...summaryCalls(details?.calls ?? [])]
    const error = result.isError ? SCRIPT_FAILED : undefined
    return host.harness().commit(async (tx) => {
      const doc = await tx.doc(SummaryDoc, api.conversationId)
      const pending = await tx.doc(PendingDoc, api.conversationId)
      if (doc.calls[call.id] || pending.calls.includes(call.id)) return
      const fixed = fixedLine(calls, error, helperCalls === undefined)
      if (fixed) return recordSummaryLineAndEvent(tx, api.conversationId, call.id, fixed)
      pending.calls.push(call.id)
      await tx.createTask(
        Summary,
        { call: call.id, input: summaryInput(calls, error) },
        {
          ownership: { kind: 'conversation' },
          conversationId: api.conversationId,
          background: true,
        },
      )
    }, BACKGROUND_CONTEXT)
  }
  const Summary = defineTask<{ call: string; input: string }, { phase: 'summarize' }, null>({
    name: 'codemode.summary',
    version: 1,
    initial: () => ({ phase: 'summarize' }),
    phases: {
      summarize: async (task, runtime, ctx) => {
        const conversations = host.need(ConversationsApi)
        let response = await runtime.memo<ResponseReceipt>('response', ctx)
        let model = await runtime.memo<SummaryModel>('model', ctx)
        const requestMarkedBeforeSend = await runtime.memo<boolean>('asked', ctx)
        let summary: CallSummary | undefined
        try {
          if (!model) {
            const chosen = await conversations.summaryModel()
            if (chosen) model = await runtime.memo('model', chosen, ctx)
          }
          if (model && (response || !requestMarkedBeforeSend)) {
            if (!response) await runtime.memo('asked', true, ctx)
            response = await conversations.askSummaryModel(
              runtime.models,
              SUMMARY_SYSTEM,
              task.input.input,
              AbortSignal.any([runtime.signal, AbortSignal.timeout(60_000)]),
              { model, response, save: (received) => runtime.memo('response', received, ctx) },
            )
            if (response.stopReason === 'stop') summary = parseSummary(response.text)
          }
        } catch (error) {
          if (runtime.signal.aborted) throw error
        }
        await runtime.commit(async (tx) => {
          await conversations.accountResponse(tx, runtime.conversationId, response)
          await settle(tx, runtime.conversationId, task.input.call, summary)
          return terminal
        }, ctx)
      },
    },
    abort: async (task, runtime, ctx) => {
      const response = await runtime.memo<ResponseReceipt>('response', ctx)
      await runtime.commit(async (tx) => {
        await host.need(ConversationsApi).accountResponse(tx, runtime.conversationId, response)
        await settle(tx, runtime.conversationId, task.input.call)
        return { status: 'terminal', outcome: { status: 'aborted' } } as const
      }, ctx)
    },
  })
  async function settle(tx: Tx, conversation: ConversationId, call: string, summary?: CallSummary) {
    const pending = await tx.doc(PendingDoc, conversation)
    pending.calls = pending.calls.filter((open) => open !== call)
    if (summary) await recordSummaryLineAndEvent(tx, conversation, call, summary)
  }
  async function recordSummaryLineAndEvent(
    tx: Tx,
    conversation: ConversationId,
    call: string,
    summary: CallSummary,
  ) {
    const doc = await tx.doc(SummaryDoc, conversation)
    doc.calls[call] = summary
    const ids = Object.keys(doc.calls)
    for (const old of ids.slice(0, Math.max(0, ids.length - KEPT_SUMMARY_LIMIT)))
      delete doc.calls[old]
    await host.emit(tx, Summarized, {
      conversation,
      call,
      line: summary.line,
      effect: summary.effect === true,
    })
  }
  const topLevelCodemode = (call: ToolHookCall) => call.name === 'codemode' && !call.parent
  return defineExtension({
    name: 'codemode',
    tasks: [Summary],
    tools: [
      ...pi.tools!.map((tool) =>
        tool.name === 'pi.codemode.models.classify'
          ? {
              ...tool,
              ...safeToRerun(
                'A classifier call only reads its input; a rerun bills one more call of a fraction of a cent.',
              ),
            }
          : tool,
      ),
      actionTool,
      tellTool,
    ],
    hooks: [
      modelCallLimits(() => host.harness()),
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          if (!topLevelCodemode(call)) return undefined
          helperCallsByTask.set(api.taskId, [])
          await copyRetiredStoreOnce(api, context)
          const code = call.arguments.code
          return typeof code === 'string'
            ? { arguments: { ...call.arguments, code: withDefaultTimeout(code) } }
            : undefined
        },
        afterTool: async (call, result, api) => {
          if (topLevelCodemode(call)) await summarize(api, call, result)
          return undefined
        },
      }),
    ],
    sections: [
      section('codemode', async (input, context) => {
        if (!input.agent.tools.some((tool) => tool.name === 'codemode')) return undefined
        const tools = await piSection.render(input, context)
        return [
          'Use codemode for dependent/parallel calls, filtered results or introspection; single calls use tools directly. Use edit/write outside codemode so changes show as diffs.' +
            (input.agent.tools.some((tool) => tool.name === 'restart')
              ? ' Call restart only at top level.'
              : '') +
            ' Only text(), image() and return values enter context; filter to concise findings.' +
            ' Discover extension contracts with ultimate.apis() and read one with ultimate.api(name); act on them through tools.action({extension, action, args}).' +
            ' A subagent started from a script runs in the background; wait for it at top level.',
          `A script makes at most ${MAX_MODEL_CALLS} models.classify/generateImages calls; its result ends with a usage line. A script resumes after a restart; keep long-run progress with store() so a later call can continue.`,
          `Read-only introspection globals (each result is journaled):\n\`\`\`ts\n${declarations}\n\`\`\``,
          tools,
        ]
          .filter(Boolean)
          .join('\n\n')
      }),
    ],
  })
}
