import type {
  ConversationId,
  EntryId,
  TaskId,
  Extension,
  ToolExecutionResult,
  ToolRegistration,
  ToolTaskInput,
} from '@earendil-works/pi-durable'
// The call trace: who called what, for how long, whether it failed, and the work it belongs to. Tool executions,
// extension actions, reactor handlers and service calls each run in a trace context (AsyncLocalStorage, which survives
// Pi Durable commits and its task runner); each call becomes the parent of the calls it makes, and events emitted
// inside carry the context, so a reaction continues the emitter's chain. Model calls get a row each, linked to their
// conversation. Rows are buffered and written to `<home>/trace.sqlite` off the call path, never inside a Pi commit;
// tracing never changes or fails a call. A successful action or service call that starts its trace and repeats one
// written within the last minute, with the same name and arguments (a UI poll), is only counted (`polls()`), as are
// the calls it makes.
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { EventContext } from '../shared/events.ts'
import { batch, every } from '../lib/timers.ts'
import { meansNone } from '../lib/errors.ts'
import type { Cancel } from '../lib/timers.ts'

export type TraceContext = EventContext & { traceId: string; parentCall: string }
export type CallKind = 'service' | 'action' | 'reactor' | 'tool' | 'model'
/** What a traced call is; ids given here override those of the enclosing work. */
export interface Call {
  kind: CallKind
  caller: string
  callee: string
  name: string
  args?: unknown
  conversationId?: ConversationId
  taskId?: TaskId
  entryId?: EntryId
  /** Record neither arguments nor result (a tool's live in the transcript). */
  sealed?: boolean
  /** A read-only poll: on success, counted in `polls()` instead of written, with the plain calls it makes. */
  poll?: boolean
}
export interface CallRow {
  id: string
  parent?: string
  trace: string
  at: string
  ms: number
  caller: string
  callee: string
  kind: CallKind
  name: string
  ok: boolean
  error?: string
  args?: string
  result?: string
  conversation?: ConversationId
  task?: TaskId
  entry?: EntryId
}
export type CallTree = CallRow & { children: CallTree[] }
export interface TraceQuery {
  trace?: string
  conversation?: ConversationId
  /** ISO time; only calls that started after it. */
  since?: string
  /** The newest calls, at most 1000; default 100. */
  limit?: number
}

const storage = new AsyncLocalStorage<TraceContext>()
/** The trace context of the running work, if any. */
export const traceContext = () => storage.getStore()

const LIMIT = 300
/** How long a written successful action or service call stands for its repeats. */
const REPEAT_MS = 60_000
/**
 * The key of a call that starts its trace (as UI polls do) and can repeat: an action or service call with comparable
 * arguments. Nested calls belong to their parent's tree; sealed ones have no arguments to compare.
 */
const repeatKey = (call: Call, parent: EventContext | null, args: string | undefined) =>
  !parent && (call.kind === 'action' || call.kind === 'service') && !call.sealed
    ? `${call.name}\0${args ?? ''}`
    : undefined
const SECRET = /secret|token|password|key|auth/i
// Calls into these extensions carry credentials (secret values; API keys and OAuth codes answering a model login), so
// they keep no arguments, results or error messages, which may echo them; only the error's class.
const SEALED = new Set(['secrets', 'models'])

/** What a failed call stored: the error message, or for a call carrying credentials only the error's class. */
function failure(error: unknown, credentials: boolean) {
  if (credentials) return error instanceof Error ? error.name : typeof error
  return error instanceof Error ? error.message : String(error)
}

/**
 * What a tool's error result says, cut at about 300 characters: its error diagnostics, then its text. A shell command
 * that exits nonzero has no text parts, its retained output tail sits in `structuredOutput.output`, and its one error
 * diagnostic says `Command exited with code 2`; that is the row's error.
 */
function toolError(result: ToolExecutionResult) {
  const text = [
    ...(result.diagnostics ?? []).flatMap((item) =>
      item.severity === 'error' ? [item.message] : [],
    ),
    ...(result.output ?? []).flatMap((part) => (part.type === 'text' ? [part.text] : [])),
  ].join('\n')
  return text.length <= LIMIT ? text : text.slice(0, LIMIT) + '…'
}

/** JSON of `value`, cut at about 300 characters, with values under secret-looking keys replaced. */
export function summary(value: unknown) {
  if (value === undefined) return undefined
  let budget = LIMIT
  try {
    const text = JSON.stringify(value, (key, item: unknown) => {
      if (budget <= 0) return undefined
      if (key && SECRET.test(key)) item = '[redacted]'
      if (typeof item === 'string' && item.length > budget) item = item.slice(0, budget)
      budget -= key.length + (item && typeof item === 'object' ? 2 : String(item).length)
      return item
    })
    return text === undefined || text.length <= LIMIT ? text : text.slice(0, LIMIT) + '…'
  } catch {
    // A cycle or a BigInt: the summary says so instead of failing the call.
    return '[unserializable]'
  }
}

/** The call trace of one home: open while the harness is, a no-op recorder otherwise. */
export function callTrace(file: string | (() => string), retention = { rows: 200_000, days: 7 }) {
  let database: DatabaseSync | undefined
  let insert: ReturnType<DatabaseSync['prepare']> | undefined
  let buffer: unknown[][] = []
  const scheduleFlush = batch(200, flush, { unref: true })
  let stopPruning: Cancel | undefined
  let reported = false
  const failed = (error: unknown) => {
    if (reported) return
    reported = true
    console.error('Call trace failed; dropping trace records:', error)
  }
  /** The contexts of traced tool runs: the tool's extension, and whether the run has ended. */
  const toolRuns = new WeakMap<TraceContext, { extension: string; done: boolean }>()
  /** Running tool calls by `<task>/<call id>`, so a Pi nested call, a task of its own, finds its caller. */
  const tools = new Map<string, TraceContext>()
  /** When each successful trace-starting action or service call, by name and arguments, was last written. */
  const written = new Map<string, number>()
  /** Repeats not written since the trace opened, by call name. */
  const polls = new Map<string, { count: number; since: number }>()
  /**
   * Contexts of calls not written when they succeed: polls (`Call.poll`, or a repeat of one written within
   * `REPEAT_MS`) and the successful action and service calls they make. Any row written below one unmarks it and its
   * marked ancestors, so a written child always has its parents; children finish first.
   */
  // By call id, not context object: an event carries a copy of its emitter's context, which a reactor runs under.
  const repeats = new Set<string>()
  /** The parent call of each marked call, to unmark the chain; dropped when the call finishes. */
  const marked = new Map<string, string | undefined>()
  const unmark = (call: string | undefined) => {
    while (call !== undefined && repeats.has(call)) {
      repeats.delete(call)
      call = marked.get(call)
    }
  }
  const countRepeat = (name: string) => {
    const counted = polls.get(name)
    if (counted) counted.count++
    else polls.set(name, { count: 1, since: Date.now() })
  }

  function flush() {
    scheduleFlush.cancel()
    const rows = buffer
    buffer = []
    if (!database || !rows.length) return
    try {
      database.exec('BEGIN')
      for (const row of rows) insert!.run(...(row as never[]))
      database.exec('COMMIT')
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK')
      failed(error)
    }
  }
  function prune() {
    try {
      flush()
      database?.prepare('DELETE FROM calls WHERE at < ?').run(Date.now() - retention.days * 864e5)
      database
        ?.prepare(
          'DELETE FROM calls WHERE rowid <= (SELECT rowid FROM calls ORDER BY rowid DESC LIMIT 1 OFFSET ?)',
        )
        .run(retention.rows)
    } catch (error) {
      failed(error)
    }
  }
  const row = (value: Record<string, unknown>): CallRow => {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value))
      if (item !== null)
        result[key] =
          key === 'ok' ? item === 1 : key === 'at' ? new Date(item as number).toISOString() : item
    return result as unknown as CallRow
  }
  const select = (where: string, order: string, ...values: (string | number)[]) => {
    flush()
    if (!database) return []
    return database
      .prepare(`SELECT ${COLUMNS.join(', ')} FROM calls ${where} ORDER BY ${order}`)
      .all(...values)
      .map((value) => row(value as Record<string, unknown>))
  }

  /**
   * Start traced call `call`, a child of `parent` (`null` for a new trace): the context its work runs in, and `finish`,
   * which records the row; for work that is no function call, such as a model stream.
   */
  function begin(call: Call, parent: EventContext | null) {
    const id = randomUUID()
    const conversationId = call.conversationId ?? parent?.conversationId
    const taskId = call.taskId ?? parent?.taskId
    const entryId = call.entryId ?? parent?.entryId
    const context: TraceContext = {
      traceId: parent?.traceId ?? id,
      parentCall: id,
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(taskId === undefined ? {} : { taskId }),
      ...(entryId === undefined ? {} : { entryId }),
    }
    const credentials = SEALED.has(call.callee)
    const sealed = call.sealed || credentials
    const args = (!sealed && summary(call.args)) || undefined
    const repeat = repeatKey({ ...call, sealed }, parent, args)
    const last = repeat === undefined ? undefined : written.get(repeat)
    // Inside a poll, only plain action and service calls go with it: a tool, model or sealed call is always written.
    const plain = (call.kind === 'action' || call.kind === 'service') && !sealed
    if (
      call.poll ||
      (plain && parent?.parentCall !== undefined && repeats.has(parent.parentCall)) ||
      (last !== undefined && Date.now() - last < REPEAT_MS)
    ) {
      repeats.add(id)
      marked.set(id, parent?.parentCall)
    }
    const started = performance.now()
    // Epoch milliseconds with a fraction, so a parent sorts before the child it started in the same millisecond.
    const at = performance.timeOrigin + started
    const finish = (ok: boolean, value: unknown) => {
      // Drop the call's marks first, so a closed trace (or one that failed to open) does not keep them.
      const skipped = ok && repeats.has(id)
      repeats.delete(id)
      marked.delete(id)
      if (!database) return
      try {
        // A repeat that failed is news: it is written like any failure, with its marked ancestors.
        if (skipped) return countRepeat(call.name)
        unmark(parent?.parentCall)
        if (ok && repeat !== undefined) {
          const now = Date.now()
          written.set(repeat, now)
          if (written.size > 10_000)
            for (const [old, when] of written) if (now - when >= REPEAT_MS) written.delete(old)
        }
        buffer.push([
          id,
          parent?.parentCall ?? null,
          context.traceId,
          at,
          Math.round((performance.now() - started) * 100) / 100,
          call.caller,
          call.callee,
          call.kind,
          call.name,
          ok ? 1 : 0,
          ok ? null : failure(value, credentials),
          args ?? null,
          (ok && !sealed && summary(value)) || null,
          context.conversationId ?? null,
          context.taskId ?? null,
          context.entryId ?? null,
        ])
        scheduleFlush()
      } catch (error) {
        failed(error)
      }
    }
    return { context, finish }
  }

  /**
   * Run `work` as traced call `call`, a child of `parent`: the enclosing call by default, `null` for a new trace. A
   * value or throw passes through; a promise is returned as one settling with the same value or error, and the row is
   * recorded once it settles.
   */
  function run<T>(
    call: Call,
    work: () => T,
    parent: EventContext | null = traceContext() ?? null,
  ): T {
    const { context, finish } = begin(call, parent)
    let result: T
    try {
      result = storage.run(context, work)
    } catch (error) {
      finish(false, error)
      throw error
    }
    if (!(result instanceof Promise)) {
      finish(true, result)
      return result
    }
    // A promise that settles the same way, so a rejection nobody handles still surfaces as unhandled.
    return result.then(
      (value: unknown) => {
        finish(true, value)
        return value
      },
      (error: unknown) => {
        finish(false, error)
        throw error
      },
    ) as T
  }

  return {
    run,
    begin,
    /**
     * Write the call running in `context` and its marked ancestors, even when they repeat: it emitted a durable event,
     * whose reactors continue its trace later and need it as their parent. Called by `emit`, inside the call.
     */
    keep: (context: EventContext | undefined) => unmark(context?.parentCall),
    /** How many running calls are marked as skippable polls; 0 whenever no call runs. */
    marked: () => marked.size,
    /** Open the trace file (the active chapter's) and apply retention, then hourly; a failure leaves tracing off. */
    open() {
      if (database) return
      written.clear()
      polls.clear()
      try {
        database = new DatabaseSync(typeof file === 'string' ? file : file())
        // Commits need not fsync: a crash may lose the newest trace rows, never corrupt the file.
        database.exec(`PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, parent TEXT, trace TEXT NOT NULL, at REAL NOT NULL,
  ms REAL NOT NULL, caller TEXT NOT NULL, callee TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
  ok INTEGER NOT NULL, error TEXT, args TEXT, result TEXT, conversation INTEGER, task INTEGER, entry INTEGER);
CREATE INDEX IF NOT EXISTS calls_trace ON calls (trace);
CREATE INDEX IF NOT EXISTS calls_conversation ON calls (conversation);
CREATE INDEX IF NOT EXISTS calls_at ON calls (at);`)
        insert = database.prepare(
          `INSERT OR IGNORE INTO calls (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
        )
        prune()
        stopPruning = every(36e5, prune, { unref: true })
      } catch (error) {
        database?.close()
        database = undefined
        failed(error)
      }
    },
    /** Write what is buffered and close; calls go on untraced until the next open. */
    close() {
      flush()
      stopPruning?.()
      database?.close()
      database = undefined
    },
    /** Every tool of `extension` runs traced, linked to its conversation, task and tool-call entry. */
    tools(extension: Extension): Extension {
      if (!extension.tools?.length) return extension
      const traced = (tool: ToolRegistration): ToolRegistration => ({
        ...tool,
        execute: async (args, api, context) => {
          let input: ToolTaskInput | undefined
          try {
            input = (await api.getTask(api.taskId, context))?.input as ToolTaskInput | undefined
          } catch (error) {
            input = meansNone(error)
          }
          // A task runs its own call; a tool another tool calls in-process with its api (codemode's `tools.*`) runs
          // inside its caller's task. Its parent is the enclosing run, a Pi nested call's is its calling tool's run;
          // either only while that tool runs. Anything else (a model call, a context left by a timer or a commit
          // after its tool ended) starts a trace.
          const own =
            input && (input.kind === 'model' ? input.callId : input.call.id) === api.callId
              ? input
              : undefined
          const enclosing = !own
            ? traceContext()
            : own.kind === 'nested'
              ? tools.get(`${own.parent}/${own.parentCallId}`)
              : undefined
          const caller = enclosing && toolRuns.get(enclosing)
          const parent = caller?.done === false ? enclosing : undefined
          const call: Call = {
            kind: 'tool',
            caller: caller?.done === false ? caller.extension : 'agent',
            callee: extension.name,
            name: tool.name,
            conversationId: api.conversationId,
            taskId: api.taskId,
            entryId: input?.kind === 'model' ? input.assistant : undefined,
            sealed: true,
          }
          const { context: self, finish } = begin(call, parent ?? null)
          const key = `${api.taskId}/${api.callId}`
          const state = { extension: extension.name, done: false }
          toolRuns.set(self, state)
          tools.set(key, self)
          try {
            const result = await storage.run(self, () => tool.execute(args, api, context))
            // A tool that returns an error result failed, though it did not throw; its row keeps the error's text.
            if (result?.isError) finish(false, toolError(result))
            else finish(true, result)
            return result
          } catch (error) {
            finish(false, error)
            throw error
          } finally {
            tools.delete(key)
            state.done = true
          }
        },
      })
      return { ...extension, tools: extension.tools.map(traced) }
    },
    /** Read side, offered to extensions as `host.trace`. */
    reader: {
      /** The newest matching calls, oldest first. */
      query(query: TraceQuery = {}): CallRow[] {
        const since = query.since === undefined ? undefined : Date.parse(query.since)
        if (Number.isNaN(since)) throw new Error(`Invalid since: ${query.since}`)
        const filters = [
          ['trace', query.trace],
          ['conversation', query.conversation],
        ] as const
        const where: { sql: string; value: string | number }[] = filters.flatMap(
          ([column, value]) => (value === undefined ? [] : [{ sql: `${column} = ?`, value }]),
        )
        if (since !== undefined) where.push({ sql: 'at > ?', value: since })
        const limit = Math.min(Math.max(1, Math.trunc(Number(query.limit) || 100)), 1000)
        return select(
          where.length ? 'WHERE ' + where.map((filter) => filter.sql).join(' AND ') : '',
          `at DESC, rowid DESC LIMIT ${limit}`,
          ...where.map((filter) => filter.value),
        ).toReversed()
      },
      /**
       * At most `limit` (1–1000) matching calls in write order, which is finish order: `seq` is a call's position,
       * `before` and `after` exclusive positions. Newest first, oldest first with `after`. `last` is the newest
       * position written, so a reader can follow from it. `text` matches name, caller, callee, args or error;
       * `since` and `until` (epoch milliseconds) bound when a call started.
       */
      page(query: {
        before?: number
        after?: number
        since?: number
        until?: number
        kinds?: string[]
        conversation?: ConversationId
        errors?: boolean
        text?: string
        limit: number
      }): { rows: (CallRow & { seq: number })[]; last: number } {
        flush()
        if (!database) return { rows: [], last: 0 }
        const where: string[] = []
        const values: (string | number)[] = []
        const filter = (sql: string, ...given: (string | number)[]) => {
          where.push(sql)
          values.push(...given)
        }
        if (query.before !== undefined) filter('rowid < ?', query.before)
        if (query.after !== undefined) filter('rowid > ?', query.after)
        if (query.since !== undefined) filter('at >= ?', query.since)
        if (query.until !== undefined) filter('at < ?', query.until)
        if (query.kinds)
          filter(`kind IN (${query.kinds.map(() => '?').join(', ')})`, ...query.kinds)
        if (query.conversation !== undefined) filter('conversation = ?', query.conversation)
        if (query.errors) filter('ok = 0')
        if (query.text) {
          const like = `%${query.text.replace(/[\\%_]/g, '\\$&')}%`
          filter(
            `(${['name', 'caller', 'callee', 'args', 'error'].map((column) => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`,
            ...Array<string>(5).fill(like),
          )
        }
        const limit = Math.min(Math.max(1, Math.trunc(query.limit)), 1000)
        const rows = database
          .prepare(
            `SELECT rowid AS seq, ${COLUMNS.join(', ')} FROM calls ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid ${query.after === undefined ? 'DESC' : 'ASC'} LIMIT ${limit}`,
          )
          .all(...values)
          .map((value) => row(value as Record<string, unknown>) as CallRow & { seq: number })
        const last = database.prepare('SELECT max(rowid) AS last FROM calls').get() as {
          last: number | null
        }
        return { rows, last: last.last ?? 0 }
      },
      /** The first 5000 calls of trace `traceId` nested under their parents, in start order. */
      tree(traceId: string): CallTree[] {
        const nodes = select('WHERE trace = ?', 'at, rowid LIMIT 5000', traceId).map(
          (call): CallTree => ({
            ...call,
            children: [],
          }),
        )
        const byId = new Map(nodes.map((node) => [node.id, node]))
        const roots: CallTree[] = []
        for (const node of nodes) {
          const parent = node.parent === undefined ? undefined : byId.get(node.parent)
          if (parent) parent.children.push(node)
          else roots.push(node)
        }
        return roots
      },
      /** Successful action and service calls not written as repeats since the trace opened, most first. */
      polls(): { name: string; count: number; since: string }[] {
        return [...polls]
          .map(([name, { count, since }]) => ({
            name,
            count,
            since: new Date(since).toISOString(),
          }))
          .toSorted((a, b) => b.count - a.count)
      },
    },
  }
}
const COLUMNS = [
  'id',
  'parent',
  'trace',
  'at',
  'ms',
  'caller',
  'callee',
  'kind',
  'name',
  'ok',
  'error',
  'args',
  'result',
  'conversation',
  'task',
  'entry',
]
export type CallTrace = ReturnType<typeof callTrace>
export type TraceReader = CallTrace['reader']
