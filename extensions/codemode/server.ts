import { parseConversationId, offsetEntryId } from '../../lib/ids.ts'
import type {
  ConversationId,
  Cursor,
  JsonObject,
  NestedToolExecutionResult,
  ToolExecutionApi,
  ToolRegistration,
  Tx,
} from '@earendil-works/pi-durable'
import { withAbortSignal } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import { obj, str } from '@earendil-works/pi-schema'
import {
  CodemodeSandbox,
  parseCodemodeSource,
  renderDeclarations,
} from '@earendil-works/pi-codemode'
import type { CodemodeTool, CodemodeJsonSchema } from '@earendil-works/pi-codemode'
import {
  AgentDoc,
  InboxDoc,
  LiveDoc,
  UsageDoc,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  ROOT_CONVERSATION_ID,
  section,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { discoverAgents } from '../../lib/agents.ts'
import { shortTitle } from '../../lib/title.ts'
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
import { fixedLine, parseSummary, SUMMARY_SYSTEM, summaryInput } from './summary.ts'
import type { Call } from './summary.ts'

export const Store = defineDoc({
  kind: 'codemode.store',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  fork: 'asOf',
  history: 'rewindable',
  initial: (): JsonObject => ({}),
})
const KEPT_SUMMARY_LIMIT = 1000
export { SummaryDoc }
export const docs = [Store, SummaryDoc, PendingDoc]
const terminal = { status: 'terminal', outcome: { status: 'completed', result: null } } as const

function declarations(tools: readonly ToolRegistration[]): CodemodeTool[] {
  return tools
    .filter(
      (tool) =>
        tool.name !== 'restart' && (tool.callers === undefined || tool.callers.includes('tools')),
    )
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as CodemodeJsonSchema,
      outputSchema: (tool.structuredOutputSchema as CodemodeJsonSchema) ?? { type: 'string' },
      execute: () => {
        throw new Error('Declaration only')
      },
    }))
}

function scriptValue(name: string, structured: boolean, result: NestedToolExecutionResult) {
  if (structured && result.structuredOutput !== undefined) return result.structuredOutput
  const text = structured ? '' : textOf(result.structuredOutput)
  if (!result.isError) return text
  const diagnostics = result.diagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => diagnostic.message)
    .join('\n')
  throw new Error([text, diagnostics].filter(Boolean).join('\n') || `Tool ${name} failed`)
}

function textOf(value: unknown) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.flatMap((item) => (item?.type === 'text' ? [item.text as string] : [])).join('\n')
}

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

function globals(
  host: ExtensionHost,
  conversationId: ConversationId,
  context: Context,
  record?: (name: string, args: unknown[]) => (status: string) => void,
): CodemodeTool[] {
  const reads = localReads(host, context)
  const remoteMachine = (machine: unknown) => {
    if (machine !== undefined && (typeof machine !== 'string' || !machine))
      throw new Error('machine must be nonempty')
    return machine
  }
  const read =
    (op: Read, at: number): CodemodeTool['execute'] =>
    async (values, { signal }) => {
      const args = [...(values as unknown[])]
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
          signal,
        )
        if (remote) return remote.value
      }
      return reads[op](args)
    }
  const helpers: {
    name: string
    description: string
    signature: string
    execute: CodemodeTool['execute']
  }[] = [
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
      execute: () => host.uiState(context),
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
        'Recorded calls (service, action, reactor, tool, model): the newest `limit` (default 100, at most 1000), oldest first; filter by trace id, conversation or ISO `since`.',
      signature:
        '(query?: { trace?: string; conversation?: number; since?: string; limit?: number; project?: string; machine?: string }): Promise<{ id: string; parent?: string; trace: string; at: string; ms: number; caller: string; callee: string; kind: string; name: string; ok: boolean; error?: string; args?: string; result?: string; conversation?: number; task?: number; entry?: number }[]>',
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
      name: 'action',
      description:
        "Call an extension action, as the UI does, on behalf of this conversation; ultimate.extensions() lists each extension's actions, its README their args.",
      signature: '(extension: string, action: string, args?: unknown): Promise<unknown>',
      execute: (values) => {
        const [extension, action, args = null] = values as [string, string, unknown?]
        return host.invoke(
          extension,
          action,
          args as JsonValue,
          context.abortSignal!,
          conversationId,
        )
      },
    },
    {
      name: 'tell',
      description:
        "Message another project's @ultimate (only @ultimate reaches it, as a message from you, never the user), as @ultimate only; with reply (default true) its answer returns to you as a reply. machine picks one instance when the project runs on several.",
      signature:
        '(input: { project: string; text: string; reply?: boolean; machine?: string }): Promise<{ message: number; delivered: number }>',
      execute: ([input], { signal }) => {
        const { project, text, reply, machine } = (input ?? {}) as Record<string, unknown>
        if (typeof project !== 'string' || !project) throw new Error('project must be nonempty')
        if (typeof text !== 'string' || !text.trim()) throw new Error('text must be nonempty')
        if (reply !== undefined && typeof reply !== 'boolean')
          throw new Error('reply must be a boolean')
        if (machine !== undefined && (typeof machine !== 'string' || !machine))
          throw new Error('machine must be nonempty')
        return host.need(MessagesApi).tell(
          conversationId,
          {
            project,
            text,
            ...(reply === undefined ? {} : { reply }),
            ...(machine ? { machine } : {}),
          },
          withAbortSignal(signal, context),
        )
      },
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
      execute: async () => {
        const graph = await host.harness().watchTaskGraph(context)
        await graph.stop()
        return JSON.parse(JSON.stringify(graph.value))
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
      execute: async (values, { signal }) => {
        const [kind, conversation, options] = values as [unknown, unknown, unknown]
        const project =
          options && typeof options === 'object' && 'project' in options
            ? options.project
            : undefined
        if (project !== undefined) {
          if (typeof project !== 'string' || !project) throw new Error('project must be nonempty')
          const args = [kind, conversation ?? ROOT_CONVERSATION_ID] as JsonValue[]
          const machine = remoteMachine((options as Record<string, unknown>).machine)
          const remote = await readProject(host, { project, machine }, 'doc', args, signal)
          if (remote) return remote.value
        }
        return reads.doc([kind, conversation ?? conversationId])
      },
    },
  ]
  return helpers.map((helper) => ({
    ...helper,
    name: `ultimate.${helper.name}`,
    spread: true,
    outputSchema: {},
    execute: async (args, options) => {
      const settle = record?.(`ultimate.${helper.name}`, args as unknown[])
      try {
        const value = await helper.execute(args, options)
        settle?.('ok')
        return value
      } catch (error) {
        settle?.(options.signal.aborted ? 'cancelled' : 'error')
        throw error
      }
    },
  }))
}

export const actions = {
  async read(input: JsonValue, { host, signal }: ActionContext) {
    const { op, args } = (input ?? {}) as { op?: unknown; args?: unknown }
    if (!READS.includes(op as Read)) throw new Error(`op must be one of ${READS.join(', ')}`)
    if (args !== undefined && !Array.isArray(args)) throw new Error('args must be an array')
    const value = await localReads(host, withAbortSignal(signal, BACKGROUND_CONTEXT))[op as Read](
      args ?? [],
    )
    const result = JSON.parse(JSON.stringify(value ?? null)) as JsonValue
    if (Buffer.byteLength(JSON.stringify(result)) > REMOTE_BYTES)
      throw new Error('The answer is larger than 1 MiB; ask for a smaller limit')
    return result
  },
}

export default function codemode(host: ExtensionHost) {
  const globalDeclarations = globals(host, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT).filter(
    (global) => global.name !== 'ultimate.tell',
  )
  const codemodeTool = defineTool({
    name: 'codemode',
    callers: ['model'],
    replay: 'unsafe',
    description:
      'Run an async JavaScript function body in a QuickJS/WASM sandbox. Call tools.<name>(args), use Promise.all for parallel calls, text()/console.log() for output, return for JSON, store(key,value)/load(key) for durable conversation values (at most 256K characters of JSON per value, 1M in all). Store writes are saved only when the script finishes successfully; a yielded wait discards them. No host I/O except injected functions. Nested results stay out of model context; nested calls run tool hooks like top-level calls. Tools with structured output resolve to it: tools.bash gives {output, truncated, exitCode} and a nonzero exit does not throw, so check exitCode. Optional first line: // @options: {"timeout_ms":60000,"max_output_tokens":10000}.\n\n' +
      renderDeclarations({ globals: globalDeclarations }),
    parameters: obj({ code: str() }),
    async execute({ code: source }, api, context) {
      const calls: {
        name: string
        args: unknown
        status: string
        ms: number
        conversationId?: ConversationId
        background?: boolean
      }[] = []
      const subagentAnswers = new Set<number>()
      const streamSettledCall = (name: string, call: (typeof calls)[number]) => {
        if (!context.abortSignal?.aborted)
          api.output(
            `${call.status === 'ok' ? '✓' : '✗'} ${name} ${(JSON.stringify(call.args) ?? '').slice(0, 200)} ${call.ms}ms\n`,
          )
      }
      const record = (name: string, args: unknown[]) => {
        const started = performance.now()
        const call: (typeof calls)[number] = { name, args, status: 'running', ms: 0 }
        calls.push(call)
        return (status: string) => {
          call.status = status
          call.ms = Math.round(performance.now() - started)
          streamSettledCall(name, call)
        }
      }
      const controller = new AbortController()
      const terminateSandboxBeforeYield = () => controller.abort()
      const sandboxContext = withAbortSignal(controller.signal, context)
      let yielded = false
      const agent = await api.agent(context)
      const tools = declarations(agent.tools).map((declaration): CodemodeTool => ({
        ...declaration,
        execute: async (args, { signal }) => {
          const name = declaration.name
          const started = performance.now()
          const call: (typeof calls)[number] = { name, args, status: 'running', ms: 0 }
          calls.push(call)
          try {
            const result = await api.executeTool(
              name,
              (args ?? {}) as JsonObject,
              withAbortSignal(signal, context),
            )
            signal.throwIfAborted()
            const details =
              result.details && typeof result.details === 'object' && !Array.isArray(result.details)
                ? result.details
                : undefined
            if (name === 'subagent' && details?.yielded === true) {
              call.status = 'yielded'
              if (typeof details.conversationId === 'number')
                call.conversationId = parseConversationId(details.conversationId)
              if (typeof details.background === 'boolean') call.background = details.background
              yielded = true
              terminateSandboxBeforeYield()
              return undefined
            }
            const structured = agent.tools.some(
              (tool) => tool.name === name && tool.structuredOutputSchema !== undefined,
            )
            const value = scriptValue(name, structured, result)
            if (name === 'subagent' && typeof details?.answerId === 'number')
              subagentAnswers.add(details.answerId)
            call.status = result.isError ? 'error' : 'ok'
            return value
          } catch (error) {
            call.status = signal.aborted ? 'cancelled' : 'error'
            throw error
          } finally {
            call.ms = Math.round(performance.now() - started)
            streamSettledCall(`tools.${call.name}`, call)
          }
        },
      }))
      try {
        const parsed = parseCodemodeSource(source)
        const saved = await api.snapshot(Store, api.conversationId, context)
        const sandbox = new CodemodeSandbox({
          tools,
          globals: globals(host, api.conversationId, sandboxContext, record),
          timeoutMs: parsed.options.timeoutMs ?? 60000,
          memoryLimitBytes: 256 * 1024 * 1024,
        })
        let result
        try {
          result = await sandbox.execute(parsed.code, {
            signal: sandboxContext.abortSignal,
            store: saved ?? {},
          })
        } finally {
          await sandbox.close()
        }
        for (const call of calls) if (call.status === 'running') call.status = 'cancelled'
        const scriptYielded = yielded && !context.abortSignal?.aborted
        const pendingSubagents = calls
          .filter(
            (call) =>
              call.name === 'subagent' &&
              (call.status === 'yielded' || call.status === 'cancelled'),
          )
          .flatMap((call) => {
            const conversationId =
              call.conversationId ?? (call.args as { id?: number } | undefined)?.id
            return typeof conversationId === 'number'
              ? [
                  {
                    conversationId,
                    ...(call.background === undefined ? {} : { background: call.background }),
                  },
                ]
              : []
          })
        const content = [
          {
            type: 'text' as const,
            text: scriptYielded
              ? 'Script yielded to steering; subagents still running; remaining script not executed; prior side effects may have happened.\nPending subagents: ' +
                JSON.stringify(pendingSubagents) +
                '\nOutput:'
              : result.ok
                ? 'Script completed\nOutput:'
                : 'Script failed\nOutput:',
          },
          ...result.output,
        ]
        if (result.ok && result.value !== undefined)
          content.push({ type: 'text', text: JSON.stringify(result.value) })
        const budget = (parsed.options.maxOutputTokens ?? 10000) * 4
        let remaining = budget
        for (const item of content.slice(1))
          if (item.type === 'text') {
            if (item.text.length > remaining)
              item.text = item.text.slice(0, remaining) + '\n[Output truncated]'
            remaining = Math.max(0, remaining - item.text.length)
          }
        if (scriptYielded)
          return {
            output: content,
            details: { calls, yielded: true, pendingSubagents } as JsonObject,
          }
        await labelOnceBeforeToolSettlement(
          api,
          context,
          calls,
          result.ok ? undefined : result.error.message,
        )
        if (result.ok) {
          if (result.storeWrites.delete.length || Object.keys(result.storeWrites.set).length) {
            const storeCommitBeforeSettlement = api.commit(async (tx) => {
              const store = await tx.doc(Store, api.conversationId)
              for (const key of result.storeWrites.delete) delete store[key]
              Object.assign(store, result.storeWrites.set)
            }, context)
            await storeCommitBeforeSettlement
          }
          return {
            output: content,
            details: {
              calls,
              subagentAnswers: [...subagentAnswers],
              ...(result.value === undefined ? {} : { value: result.value }),
            } as JsonObject,
          }
        }
        const error = result.error.stack ?? `${result.error.kind}: ${result.error.message}`
        content.push({ type: 'text', text: error })
        return { output: content, isError: true, details: { calls, error } as JsonObject }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await labelOnceBeforeToolSettlement(api, context, calls, message)
        return {
          output: [{ type: 'text', text: `Script failed\n${message}` }],
          isError: true,
          details: { calls, error: message } as JsonObject,
        }
      }
    },
  })
  const labelOnceBeforeToolSettlement = (
    api: ToolExecutionApi,
    context: Context,
    calls: Call[],
    error?: string,
  ) =>
    api.commit(async (tx) => {
      const doc = await tx.doc(SummaryDoc, api.conversationId)
      const pending = await tx.doc(PendingDoc, api.conversationId)
      if (doc.calls[api.callId] || pending.calls.includes(api.callId)) return
      const fixed = fixedLine(calls, error)
      if (fixed) return recordSummaryLineAndEvent(tx, api.conversationId, api.callId, fixed)
      pending.calls.push(api.callId)
      await tx.createTask(
        Summary,
        { call: api.callId, input: summaryInput(calls, error) },
        {
          ownership: { kind: 'conversation' },
          conversationId: api.conversationId,
          background: true,
        },
      )
    }, context)
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
  return defineExtension({
    name: 'codemode',
    tasks: [Summary],
    tools: [codemodeTool],
    sections: [
      section('codemode', ({ agent }) =>
        agent.tools.some((tool) => tool.name === 'codemode')
          ? 'Use codemode for dependent/parallel calls, filtered results or introspection; single calls use tools directly. Use edit/write outside codemode so changes show as diffs.' +
            (agent.tools.some((tool) => tool.name === 'restart')
              ? ' Call restart only at top level.'
              : '') +
            ' Only text(), image() and return values enter context; filter to concise findings. The sandbox has no setTimeout or setInterval: wait with a bash sleep.' +
            ' Discover extension contracts with ultimate.apis() and read one with ultimate.api(name); act on them through ultimate.action. ' +
            'tools.<name>(args) takes the top-level tool arguments and rules; a tool that declares structured output resolves to it (bash: {output, exitCode}), others to their text. Available: ' +
            declarations(agent.tools)
              .map((tool) => tool.name)
              .join(', ')
          : undefined,
      ),
    ],
  })
}
