import { withAbortSignal } from '@earendil-works/chord/context'
import type { Context, JsonValue } from '@earendil-works/chord'
import { Type } from '@earendil-works/pi-ai'
import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation'
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
import type {
  ConversationId,
  Cursor,
  EntryId,
  EntryRecord,
  JsonObject,
  ToolExecutionApi,
  ToolRegistration,
  ToolExecutionResult,
  Tx,
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
import { closedChapter, id, limit, readChapter } from './chapters.ts'
import type { HistoryRead } from './chapters.ts'
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
/** The summaries a conversation keeps: older calls fall back to their script header. */
const KEPT = 1000
export { SummaryDoc }
export const docs = [Store, SummaryDoc, PendingDoc]
const terminal = { status: 'terminal', outcome: { status: 'completed', result: null } } as const

type StructuredTool = ToolRegistration & { outputSchema?: CodemodeJsonSchema }
type StructuredResult = ToolExecutionResult & { structuredContent?: unknown }

function declarations(tools: readonly ToolRegistration[]): CodemodeTool[] {
  return tools
    .filter((tool) => tool.name !== 'codemode' && tool.name !== 'restart')
    .map((tool: StructuredTool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as CodemodeJsonSchema,
      outputSchema: tool.outputSchema ?? { type: 'string' },
      execute: () => {
        throw new Error('Declaration only')
      },
    }))
}

/** The history reads codemode offers, on this project's storage; `codemode.read` serves them to other projects. */
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
  const entries = async (
    conversation: unknown,
    options: { kinds?: string[]; limit?: number; before?: number } = {},
  ) => {
    const found = await host.harness().conversation(id(conversation), context)
    if (!found) throw new Error('Unknown conversation')
    const items: EntryRecord[] = []
    let cursor: Cursor | undefined
    const count = limit(options.limit)
    do {
      const page = await found.entries(
        options.before === undefined
          ? {}
          : {
              maxEntryId: (options.before - 1) as EntryId,
            },
        100,
        cursor,
        context,
      )
      for (const entry of page.items) {
        if (!options.kinds || options.kinds.includes(entry.kind)) items.push(entry)
        if (items.length === count) return items
      }
      cursor = page.next
    } while (cursor)
    return items
  }
  const search = async (
    text: unknown,
    options: { conversationId?: number; limit?: number } = {},
  ) => {
    if (typeof text !== 'string' || !text) throw new Error('search text must be nonempty')
    const count = limit(options.limit)
    const records =
      options.conversationId === undefined
        ? await conversations()
        : [{ id: id(options.conversationId) }]
    const matches: EntryRecord[] = []
    for (const conversation of records) {
      let cursor: Cursor | undefined
      do {
        const found = await host.harness().conversation(conversation.id, context)
        if (!found) throw new Error('Unknown conversation')
        const page = await found.entries({}, 100, cursor, context)
        for (const entry of page.items) {
          if (JSON.stringify(entry).includes(text)) matches.push(entry)
          if (matches.length === count) return matches
        }
        cursor = page.next
      } while (cursor)
    }
    return matches
  }
  /**
   * Every conversation with its summary (title, label, cwd, busy, latest input) and whether it is concluded.
   * Titles are shortened: old subagent titles hold whole prompts and would push the listing past the read limit.
   */
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
      entries(conversation, options as Parameters<typeof entries>[1]),
    ),
    search: history('search', 1, ([text, options]) =>
      search(text, options as { conversationId?: number; limit?: number }),
    ),
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
  /**
   * Read `op` here, or in the project its last argument's `project` names (the option `options` at `at`), through
   * that project's running instance.
   */
  /** A read's `machine` option: which machine's instance of the project answers when it runs on several. */
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
        // Checked here: `project` is stripped below, so the chapter read never sees the pair.
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
        // The call's own signal ends with the script, its timeout or the conversation's abort.
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
          context,
          signal,
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
        'Newest-first fork-aware stored history, including before resets and compactions. before is an exclusive entry ID.',
      signature:
        '(conversationId: number, options?: { kinds?: string[]; limit?: number; before?: number; project?: string; machine?: string; chapter?: string }): Promise<unknown[]>',
      execute: read('entries', 1),
    },
    {
      name: 'search',
      description:
        'Case-sensitive substring search over all stored entry JSON, including history before resets and compactions.',
      signature:
        '(text: string, options?: { conversationId?: number; limit?: number; project?: string; machine?: string; chapter?: string }): Promise<unknown[]>',
      execute: read('search', 1),
    },
    {
      name: 'taskGraph',
      description: 'Live durable tasks and ownership graph.',
      signature: '(): Promise<unknown>',
      execute: async () => {
        const state = await host.harness().taskGraph(context)
        try {
          return JSON.parse(JSON.stringify(state.value))
        } finally {
          state.dispose()
        }
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
      // Another project has no conversation of yours to default to: it reads conversation 1 unless one is named.
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
    // Each helper call joins the script's call log, so its summary sees what it read and changed.
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
  /**
   * `{ op, args }`: another project's codemode asks this one for `ultimate.<op>(...args)` (`conversations`, `entries`,
   * `search`, `trace`, `traceTree`), read-only. Answers more than 1 MiB of JSON with an error asking for a smaller limit.
   */
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
  const globalDeclarations = globals(host, 1 as ConversationId, BACKGROUND_CONTEXT)
  const codemodeTool = defineTool({
    name: 'codemode',
    replay: 'unsafe',
    description:
      'Run an async JavaScript function body in a QuickJS/WASM sandbox. Call tools.<name>(args), use Promise.all for parallel calls, text()/console.log() for output, return for JSON, store(key,value)/load(key) for durable conversation values (at most 256K characters of JSON per value, 1M in all). Store writes are saved only when the script finishes successfully; a yielded wait discards them. No host I/O except injected functions. tools, ultimate and text are already in scope (never redeclare them); there are no timers (setTimeout and setInterval are undefined). Nested results stay out of model context. Nested tool hooks do not run. Optional first line: // @options: {"timeout_ms":60000,"max_output_tokens":10000}.\n\n' +
      renderDeclarations({ globals: globalDeclarations }),
    parameters: Type.Object({ code: Type.String() }),
    async execute({ code: source }, api, context) {
      const calls: {
        name: string
        args: unknown
        status: string
        ms: number
        conversationId?: number
        background?: boolean
      }[] = []
      const subagentAnswers = new Set<number>()
      /** Stream a settled call as `✓ <name> <args> <ms>ms`, the line the card parses while the script runs. */
      const log = (name: string, call: (typeof calls)[number]) => {
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
          log(name, call)
        }
      }
      const controller = new AbortController()
      const sandboxContext = withAbortSignal(controller.signal, context)
      let yielded = false
      const agent = await api.agent(context)
      const tools = declarations(agent.tools).map((declaration): CodemodeTool => ({
        ...declaration,
        execute: async (args, { signal }) => {
          const resolved = agent.tools.find(
            (tool) => tool.name === declaration.name,
          )! as StructuredTool
          const started = performance.now()
          const call: (typeof calls)[number] = {
            name: resolved.name,
            args,
            status: 'running',
            ms: 0,
          }
          calls.push(call)
          let output = ''
          let active = true
          const nested: ToolExecutionApi = {
            ...api,
            callId: `${api.callId}/${calls.length}`,
            output: (chunk) => {
              if (active)
                output += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
            },
            details: async () => {},
            diagnostic: (diagnostic) => {
              if (active) output += `\n${diagnostic.message}`
            },
            memo: (name: string, candidateOrContext: JsonValue | Context, memoContext?: Context) =>
              memoContext === undefined
                ? api.memo(`${nested.callId}/${name}`, candidateOrContext as Context)
                : api.memo(
                    `${nested.callId}/${name}`,
                    candidateOrContext as JsonValue,
                    memoContext,
                  ),
          }
          try {
            const prepared = resolved.prepareArguments ? resolved.prepareArguments(args) : args
            const validated = validateToolArguments(resolved, {
              type: 'toolCall',
              id: nested.callId,
              name: resolved.name,
              arguments: prepared as JsonObject,
            })
            const result: StructuredResult = await resolved.execute(
              validated,
              nested,
              withAbortSignal(signal, context),
            )
            signal.throwIfAborted()
            const details =
              result.details && typeof result.details === 'object' && !Array.isArray(result.details)
                ? result.details
                : undefined
            if (resolved.name === 'subagent' && details?.yielded === true) {
              call.status = 'yielded'
              if (typeof details.conversationId === 'number')
                call.conversationId = details.conversationId
              if (typeof details.background === 'boolean') call.background = details.background
              yielded = true
              // Abort synchronously: pi-codemode clears pending replies and terminates the VM,
              // so neither a resolved value nor a catch/finally can resume the script.
              controller.abort()
              return undefined
            }
            const text =
              result.output === undefined
                ? output
                : result.output.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
            const error = [
              text,
              ...(result.diagnostics ?? []).map((diagnostic) => diagnostic.message),
            ]
              .filter(Boolean)
              .join('\n')
            if (result.isError) throw new Error(error || `Tool ${resolved.name} failed`)
            if (resolved.name === 'subagent' && typeof details?.answerId === 'number')
              subagentAnswers.add(details.answerId)
            call.status = 'ok'
            return resolved.outputSchema && result.structuredContent !== undefined
              ? result.structuredContent
              : text
          } catch (error) {
            call.status = signal.aborted ? 'cancelled' : 'error'
            throw error
          } finally {
            active = false
            call.ms = Math.round(performance.now() - started)
            log(`tools.${call.name}`, call)
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
        await summarize(api, context, calls, result.ok ? undefined : result.error.message)
        if (result.ok) {
          if (result.storeWrites.delete.length || Object.keys(result.storeWrites.set).length) {
            // Pi Durable has no result transaction, so this commits separately: a crash can retain writes while reporting the call interrupted.
            await api.commit(async (tx) => {
              const store = await tx.doc(Store, api.conversationId)
              for (const key of result.storeWrites.delete) delete store[key]
              Object.assign(store, result.storeWrites.set)
            }, context)
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
        await summarize(api, context, calls, message)
        return {
          output: [{ type: 'text', text: `Script failed\n${message}` }],
          isError: true,
          details: { calls, error: message } as JsonObject,
        }
      }
    },
  })
  /**
   * Give call `api.callId` its one line: a fixed label for a trivial script, written now, or a background task that asks
   * the summary model. Created in its own commit before the result; the call does not rerun, and a call that already
   * has a line or a pending task gets no second one.
   */
  const summarize = (api: ToolExecutionApi, context: Context, calls: Call[], error?: string) =>
    api.commit(async (tx) => {
      const doc = await tx.doc(SummaryDoc, api.conversationId)
      const pending = await tx.doc(PendingDoc, api.conversationId)
      if (doc.calls[api.callId] || pending.calls.includes(api.callId)) return
      const fixed = fixedLine(calls, error)
      if (fixed) return keep(tx, api.conversationId, api.callId, fixed)
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
        // Marked before asking: a restart between the request and its saved response does not ask again.
        const asked = await runtime.memo<boolean>('asked', ctx)
        let summary: CallSummary | undefined
        try {
          if (!model) {
            const chosen = await conversations.summaryModel()
            if (chosen) model = await runtime.memo('model', chosen, ctx)
          }
          if (model && (response || !asked)) {
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
          // The line is optional: without one the card keeps its script header.
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
  /** End call `call`'s summary task in `tx`: keep its line when there is one, and drop it from the pending ones. */
  async function settle(tx: Tx, conversation: ConversationId, call: string, summary?: CallSummary) {
    const pending = await tx.doc(PendingDoc, conversation)
    pending.calls = pending.calls.filter((open) => open !== call)
    if (summary) await keep(tx, conversation, call, summary)
  }
  /** Store call `call`'s line and record it as an event, in `tx`. */
  async function keep(tx: Tx, conversation: ConversationId, call: string, summary: CallSummary) {
    const doc = await tx.doc(SummaryDoc, conversation)
    doc.calls[call] = summary
    const ids = Object.keys(doc.calls)
    for (const old of ids.slice(0, Math.max(0, ids.length - KEPT))) delete doc.calls[old]
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
            ' Only text(), images and return values enter context; filter to concise findings.' +
            ' Discover extension contracts with ultimate.apis() and read one with ultimate.api(name); act on them through ultimate.action. ' +
            'tools.<name>(args) uses the top-level tool schemas and rules (same arguments and results). Available: ' +
            declarations(agent.tools)
              .map((tool) => tool.name)
              .join(', ')
          : undefined,
      ),
    ],
  })
}
