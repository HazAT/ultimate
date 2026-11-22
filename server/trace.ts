import type {
  ConversationId,
  EntryId,
  TaskId,
  Extension,
  ToolExecutionResult,
  ToolRegistration,
  ToolTaskInput,
} from '@earendil-works/pi-durable'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { EventContext } from '../shared/events.ts'
import { batch, every } from '../lib/timers.ts'
import { meansNone } from '../lib/errors.ts'
import type { Cancel } from '../lib/timers.ts'

export type TraceContext = EventContext & { traceId: string; parentCall: string }
export type CallKind = 'service' | 'action' | 'reactor' | 'tool' | 'model'
export interface Call {
  kind: CallKind
  caller: string
  callee: string
  name: string
  args?: unknown
  conversationId?: ConversationId
  taskId?: TaskId
  entryId?: EntryId
  sealed?: boolean
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
type IsoTimestamp = string
type EpochMilliseconds = number
type ExclusiveCallWriteSequence = number

export interface TraceQuery {
  trace?: string
  conversation?: ConversationId
  since?: IsoTimestamp
  until?: IsoTimestamp
  limit?: number
}

const storage = new AsyncLocalStorage<TraceContext>()
export const traceContext = () => storage.getStore()

const SUMMARY_CHARACTER_LIMIT = 300
const SUCCESSFUL_ROOT_CALL_REPEAT_WINDOW_MS = 60_000
const comparableUnsealedRootCallKey = (
  call: Call,
  parent: EventContext | null,
  args: string | undefined,
) =>
  !parent && (call.kind === 'action' || call.kind === 'service') && !call.sealed
    ? `${call.name}\0${args ?? ''}`
    : undefined
const SECRET = /secret|token|password|key|auth/i
const EXTENSIONS_WITH_CREDENTIALS = new Set(['secrets', 'models'])

function failure(error: unknown, credentials: boolean) {
  if (credentials) return error instanceof Error ? error.name : typeof error
  return error instanceof Error ? error.message : String(error)
}

function toolError(result: ToolExecutionResult) {
  const text = [
    ...(result.diagnostics ?? []).flatMap((item) =>
      item.severity === 'error' ? [item.message] : [],
    ),
    ...(result.output ?? []).flatMap((part) => (part.type === 'text' ? [part.text] : [])),
  ].join('\n')
  return text.length <= SUMMARY_CHARACTER_LIMIT
    ? text
    : text.slice(0, SUMMARY_CHARACTER_LIMIT) + '…'
}

export function summary(value: unknown) {
  if (value === undefined) return undefined
  let budget = SUMMARY_CHARACTER_LIMIT
  try {
    const text = JSON.stringify(value, (key, item: unknown) => {
      if (budget <= 0) return undefined
      if (key && SECRET.test(key)) item = '[redacted]'
      if (typeof item === 'string' && item.length > budget) item = item.slice(0, budget)
      budget -= key.length + (item && typeof item === 'object' ? 2 : String(item).length)
      return item
    })
    return text === undefined || text.length <= SUMMARY_CHARACTER_LIMIT
      ? text
      : text.slice(0, SUMMARY_CHARACTER_LIMIT) + '…'
  } catch {
    return '[unserializable]'
  }
}

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
  const toolRuns = new WeakMap<TraceContext, { extension: string; done: boolean }>()
  const runningToolsByTaskAndCallId = new Map<string, TraceContext>()
  const written = new Map<string, number>()
  const polls = new Map<string, { count: number; since: number }>()
  const skippableSuccessfulCallIds = new Set<string>()
  const skippableParentByCallId = new Map<string, string | undefined>()
  const keepCallAndAncestors = (call: string | undefined) => {
    while (call !== undefined && skippableSuccessfulCallIds.has(call)) {
      skippableSuccessfulCallIds.delete(call)
      call = skippableParentByCallId.get(call)
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
    const credentials = EXTENSIONS_WITH_CREDENTIALS.has(call.callee)
    const sealed = call.sealed || credentials
    const args = (!sealed && summary(call.args)) || undefined
    const repeat = comparableUnsealedRootCallKey({ ...call, sealed }, parent, args)
    const last = repeat === undefined ? undefined : written.get(repeat)
    const nestedCallMaySkipWithPoll = (call.kind === 'action' || call.kind === 'service') && !sealed
    if (
      call.poll ||
      (nestedCallMaySkipWithPoll &&
        parent?.parentCall !== undefined &&
        skippableSuccessfulCallIds.has(parent.parentCall)) ||
      (last !== undefined && Date.now() - last < SUCCESSFUL_ROOT_CALL_REPEAT_WINDOW_MS)
    ) {
      skippableSuccessfulCallIds.add(id)
      skippableParentByCallId.set(id, parent?.parentCall)
    }
    const started = performance.now()
    const fractionalEpochMs = performance.timeOrigin + started
    const finish = (ok: boolean, value: unknown) => {
      const successfulRepeat = ok && skippableSuccessfulCallIds.has(id)
      skippableSuccessfulCallIds.delete(id)
      skippableParentByCallId.delete(id)
      if (!database) return
      try {
        if (successfulRepeat) return countRepeat(call.name)
        keepCallAndAncestors(parent?.parentCall)
        if (ok && repeat !== undefined) {
          const now = Date.now()
          written.set(repeat, now)
          if (written.size > 10_000)
            for (const [old, when] of written)
              if (now - when >= SUCCESSFUL_ROOT_CALL_REPEAT_WINDOW_MS) written.delete(old)
        }
        buffer.push([
          id,
          parent?.parentCall ?? null,
          context.traceId,
          fractionalEpochMs,
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

  function recordPreservingSettlement(
    promise: Promise<unknown>,
    finish: (ok: boolean, value: unknown) => void,
  ) {
    return promise.then(
      (value: unknown) => {
        finish(true, value)
        return value
      },
      (error: unknown) => {
        finish(false, error)
        throw error
      },
    )
  }

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
    return recordPreservingSettlement(result, finish) as T
  }

  return {
    run,
    begin,
    keep: (context: EventContext | undefined) => keepCallAndAncestors(context?.parentCall),
    marked: () => skippableParentByCallId.size,
    open() {
      if (database) return
      written.clear()
      polls.clear()
      try {
        database = new DatabaseSync(typeof file === 'string' ? file : file())
        const crashSafeBatchedSchema = `PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, parent TEXT, trace TEXT NOT NULL, at REAL NOT NULL,
  ms REAL NOT NULL, caller TEXT NOT NULL, callee TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
  ok INTEGER NOT NULL, error TEXT, args TEXT, result TEXT, conversation INTEGER, task INTEGER, entry INTEGER);
CREATE INDEX IF NOT EXISTS calls_trace ON calls (trace);
CREATE INDEX IF NOT EXISTS calls_conversation ON calls (conversation);
CREATE INDEX IF NOT EXISTS calls_at ON calls (at);`
        database.exec(crashSafeBatchedSchema)
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
    close() {
      flush()
      stopPruning?.()
      database?.close()
      database = undefined
    },
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
          const taskForThisToolCall =
            input && (input.kind === 'model' ? input.callId : input.call.id) === api.callId
              ? input
              : undefined
          const enclosing = !taskForThisToolCall
            ? traceContext()
            : taskForThisToolCall.kind === 'nested'
              ? runningToolsByTaskAndCallId.get(
                  `${taskForThisToolCall.parent}/${taskForThisToolCall.parentCallId}`,
                )
              : undefined
          const caller = enclosing && toolRuns.get(enclosing)
          const stillRunningCallerContext = caller?.done === false ? enclosing : undefined
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
          const { context: self, finish } = begin(call, stillRunningCallerContext ?? null)
          const key = `${api.taskId}/${api.callId}`
          const state = { extension: extension.name, done: false }
          toolRuns.set(self, state)
          runningToolsByTaskAndCallId.set(key, self)
          try {
            const result = await storage.run(self, () => tool.execute(args, api, context))
            if (result?.isError) finish(false, toolError(result))
            else finish(true, result)
            return result
          } catch (error) {
            finish(false, error)
            throw error
          } finally {
            runningToolsByTaskAndCallId.delete(key)
            state.done = true
          }
        },
      })
      return { ...extension, tools: extension.tools.map(traced) }
    },
    reader: {
      query(query: TraceQuery = {}): CallRow[] {
        const parseTimestamp = (value: IsoTimestamp | undefined, name: string) => {
          if (value === undefined) return undefined
          const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
          if (Number.isNaN(parsed)) throw new Error(`Invalid ${name}: ${value}`)
          return parsed
        }
        const since = parseTimestamp(query.since, 'since')
        const until = parseTimestamp(query.until, 'until')
        const filters = [
          ['trace', query.trace],
          ['conversation', query.conversation],
        ] as const
        const where: { sql: string; value: string | number }[] = filters.flatMap(
          ([column, value]) => (value === undefined ? [] : [{ sql: `${column} = ?`, value }]),
        )
        if (since !== undefined) where.push({ sql: 'at > ?', value: since })
        if (until !== undefined) where.push({ sql: 'at < ?', value: until })
        const limit = Math.min(Math.max(1, Math.trunc(Number(query.limit) || 100)), 1000)
        const clause = where.length
          ? 'WHERE ' + where.map((filter) => filter.sql).join(' AND ')
          : ''
        const values = where.map((filter) => filter.value)
        if (since !== undefined)
          return select(clause, `at ASC, rowid ASC LIMIT ${limit}`, ...values)
        return select(clause, `at DESC, rowid DESC LIMIT ${limit}`, ...values).toReversed()
      },
      page(query: {
        before?: ExclusiveCallWriteSequence
        after?: ExclusiveCallWriteSequence
        since?: EpochMilliseconds
        until?: EpochMilliseconds
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
