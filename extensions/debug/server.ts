import { Type } from 'typebox'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { apiSource, apiSummaries } from '../../lib/api-files.ts'
import { defineEvent } from '../../shared/events.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { CallRow, CallTree } from '../../server/trace.ts'

/** The most text one call returns; rows past it are cut with a note. */
const BUDGET = 16_000

/** How long ago `at` (ISO) was: `40s`, `12m`, `3h`, `2d`. */
export function age(at: string, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}
const cut = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text
const json = (value: unknown, length: number) => cut(JSON.stringify(value) ?? '', length)
const ids = (values: Record<string, unknown>) =>
  Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(' ')

function call(row: CallRow) {
  return [
    row.kind,
    `${row.caller} → ${row.name}`,
    `${Math.round(row.ms)}ms`,
    row.ok ? 'ok' : `failed: ${cut(row.error ?? '', 160)}`,
    row.args && `args=${cut(row.args, 100)}`,
  ]
    .filter(Boolean)
    .join('  ')
}
function tree(nodes: CallTree[], depth = 0): string[] {
  return nodes.flatMap((node) => [
    `${'  '.repeat(depth)}${call(node)}`,
    ...tree(node.children, depth + 1),
  ])
}
/** At most `limit` lines within the budget, saying how many were left out. */
function bounded(lines: string[], limit: number) {
  const shown: string[] = []
  let size = 0
  for (const line of lines.slice(0, limit)) {
    if (size + line.length > BUDGET) break
    shown.push(line)
    size += line.length + 1
  }
  const left = lines.length - shown.length
  return shown.join('\n') + (left ? `\n… ${left} more; narrow the query or raise limit` : '')
}

export default function debug(host: ExtensionHost) {
  async function run(args: {
    call: 'events' | 'reactors' | 'catalogue' | 'trace' | 'apis' | 'api'
    events?: string[]
    since?: number | string
    limit?: number
    trace?: string
    conversation?: number
    name?: string
  }) {
    const limit = args.limit ?? (args.call === 'events' ? 20 : 50)
    switch (args.call) {
      case 'events': {
        if (args.since !== undefined && typeof args.since !== 'number')
          throw new Error('events: since is an event id (a number)')
        const events = await host.eventLog.recent({
          ...(args.events ? { events: args.events.map((name) => defineEvent(name)) } : {}),
          ...(args.since === undefined ? {} : { since: args.since }),
          limit,
        })
        const lines = events.map((event) =>
          [
            age(event.at).padEnd(4),
            `#${event.id}`,
            event.name,
            json(event.data, 160),
            ids({
              trace: event.context?.traceId,
              conversation: event.context?.conversationId,
              call: event.context?.parentCall,
            }),
          ]
            .filter(Boolean)
            .join('  '),
        )
        return lines.length ? bounded(lines, limit) : 'No events.'
      }
      case 'reactors': {
        const reactors = await host.eventLog.reactors()
        const lines = reactors.map((reactor) =>
          [
            reactor.name,
            `on ${reactor.events.join(', ')}`,
            `cursor=${reactor.cursor}`,
            `lag=${reactor.lag}`,
            reactor.running ? 'running' : 'stopped',
            reactor.failure &&
              `failed ${age(reactor.failure.at)} ago${reactor.failure.entryId === undefined ? '' : ` at #${reactor.failure.entryId}`}: ${cut(reactor.failure.error, 200)}`,
          ]
            .filter(Boolean)
            .join('  '),
        )
        return lines.length ? bounded(lines, limit) : 'No reactors.'
      }
      case 'catalogue': {
        const catalogue = host.catalogue()
        const lines = catalogue.apis.map((api) =>
          [
            api.name,
            api.owner && `point of ${api.owner}`,
            `provider=${api.provider ?? 'MISSING'}`,
            api.needs.length && `needs: ${api.needs.join(', ')}`,
            api.wants.length && `wants: ${api.wants.join(', ')}`,
          ]
            .filter(Boolean)
            .join('  '),
        )
        lines.push(`missing: ${catalogue.missing.join(', ') || 'none'}`)
        lines.push(
          `cycles: ${catalogue.cycles.map((cycle) => cycle.join(' ↔ ')).join('; ') || 'none'}`,
        )
        return bounded(lines, Number.POSITIVE_INFINITY)
      }
      case 'trace': {
        if (args.trace) return bounded(tree(host.trace.tree(args.trace)), limit) || 'No calls.'
        if (args.since !== undefined && typeof args.since !== 'string')
          throw new Error('trace: since is an ISO time (a string)')
        const rows = host.trace
          .query({
            ...(args.conversation === undefined ? {} : { conversation: args.conversation }),
            ...(args.since === undefined ? {} : { since: args.since }),
            limit,
          })
          .toReversed()
        const lines = rows.map((row) =>
          [
            age(row.at).padEnd(4),
            call(row),
            ids({ trace: row.trace, conversation: row.conversation, entry: row.entry }),
          ].join('  '),
        )
        return lines.length ? bounded(lines, limit) : 'No calls.'
      }
      case 'apis': {
        const apis = await apiSummaries(host.extensions())
        return (
          apis.map((api) => `${api.name}  ${api.summary}`).join('\n') ||
          'No api.ts or refs.ts files.'
        )
      }
      case 'api':
      default: {
        if (!args.name) throw new Error('api: name is required')
        const source = await apiSource(host.extensions(), args.name)
        return source.length > BUDGET ? `${source.slice(0, BUDGET)}\n[truncated]` : source
      }
    }
  }
  return defineExtension({
    name: 'debug',
    tools: [
      defineTool({
        name: 'debug',
        deferred: true,
        // Reads events, reactor status, the catalogue, traces and contract files; changes nothing.
        replay: 'safe',
        description:
          "Inspect Ultimate's running system to find out why something did or did not happen, and to follow one chain of work across extensions. " +
          'call: `events` lists durable events newest first (filter `events` by name like `workspaces.landed`, `since` an event id); ' +
          '`reactors` shows each reactor with its cursor, lag (pending events), whether it runs, and its last failure; ' +
          '`catalogue` lists each extension API with its provider, needs and wants, plus missing providers and cycles; ' +
          '`trace` lists recorded service, action, reactor, tool and model calls newest first (filter by `conversation` or ISO `since`), or with `trace` set the whole call tree of that trace id, indented; ' +
          "`apis` lists extension contracts (api.ts, refs.ts) with summaries and `api` returns one extension's by `name`, each file under a header. " +
          'Start from an event or a call, take its trace id and read the tree. Read-only; one line per row, ages relative; `limit` defaults to 20 events or 50 rows.',
        parameters: Type.Object({
          call: Type.Union([
            Type.Literal('events'),
            Type.Literal('reactors'),
            Type.Literal('catalogue'),
            Type.Literal('trace'),
            Type.Literal('apis'),
            Type.Literal('api'),
          ]),
          events: Type.Optional(
            Type.Array(Type.String({ minLength: 1 }), {
              description: 'events: event names to keep.',
            }),
          ),
          since: Type.Optional(
            Type.Union([Type.Integer({ minimum: 0 }), Type.String({ minLength: 1 })], {
              description: 'events: an event id to read after; trace: an ISO time.',
            }),
          ),
          trace: Type.Optional(Type.String({ minLength: 1, description: 'trace: a trace id.' })),
          conversation: Type.Optional(
            Type.Integer({ minimum: 1, description: 'trace: calls of this conversation.' }),
          ),
          name: Type.Optional(Type.String({ minLength: 1, description: 'api: extension name.' })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
        }),
        async execute(args) {
          return { output: [{ type: 'text', text: await run(args) }] }
        },
      }),
    ],
  })
}
