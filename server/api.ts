import { parseConversationId, parseEntryId, offsetEntryId } from '../lib/ids.shared.ts'
import type {
  ConversationId,
  ConversationDocToken,
  Cursor,
  DocumentWatch,
  JsonObject,
  SubmissionId,
  TaskGraph,
} from '@earendil-works/pi-durable'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { onCommit } from '../lib/commits.ts'
import { inProcess } from '../lib/errors.shared.ts'
import type {
  ServerEvents,
  ConversationSummary,
  ConfigureRequest,
  ReadSpec,
  SubscriptionsAnswer,
  SubscriptionsRequest,
  UiOp,
} from '../shared/protocol.ts'
import { createReads } from './reads.ts'
import type { Reads } from './reads.ts'
import {
  MAX_SUBSCRIPTION_BATCH_BYTES,
  UI_REVISION,
  imageMimeTypes,
  maxImageBytes,
  maxImages,
} from '../shared/protocol.ts'
import { listModels } from './models.ts'
import { hostDefault } from '../lib/agents.ts'
import { expandSkillCommand } from './skills.ts'
import type { Extensions } from './extensions.ts'
import { context } from './harness.ts'
import type { OpenHost, PreparedHost } from './harness.ts'
import type { createSystem } from './system.ts'
import { requestSwap } from './supervisor-protocol.ts'
import { UiState, UiWriters } from '../shared/ui-state.ts'
import type { JsonValue } from '@earendil-works/chord/json'
import { diffRevisions } from '@earendil-works/chord/delta'
import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { Metadata } from './metadata.ts'
import { EVENT_LOG_LABEL, emit, uiChange } from './events.ts'
import { ChangedEvent, UserInputEvent } from '../shared/events.ts'
import { admit, deviceOf, sourceOf } from './request-security.ts'
import type { Access } from './request-security.ts'
import { conversationIndex } from './project.ts'
import { shortTitle } from '../lib/title.ts'
import { batch, every } from '../lib/timers.shared.ts'

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
export class Events {
  readonly listeners = new Set<
    (name: keyof ServerEvents, data: ServerEvents[keyof ServerEvents]) => void
  >()
  emit<K extends keyof ServerEvents>(name: K, data: ServerEvents[K]) {
    for (const listener of this.listeners) listener(name, data)
  }
}
async function body(
  request: IncomingMessage,
  limit = 1024 * 1024,
  drainLimit = limit,
): Promise<Record<string, unknown>> {
  let data = ''
  let bytes = 0
  let tooLarge = false
  request.setEncoding('utf8')
  for await (const chunk of request) {
    const piece = chunk.toString()
    bytes += Buffer.byteLength(piece)
    if (bytes > limit) {
      tooLarge = true
      data = ''
      if (bytes > drainLimit) throw new HttpError(413, 'Request too large')
    } else data += piece
  }
  if (tooLarge) throw new HttpError(413, 'Request too large')
  try {
    const value = JSON.parse(data || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  } catch {
    throw new HttpError(400, 'Expected a JSON object')
  }
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `Expected ${name}`)
  return value
}
const validUiKey = (key: unknown): key is string =>
  typeof key === 'string' && key.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(key)
function uiOps(ops: unknown): UiOp[] {
  if (!Array.isArray(ops)) throw new HttpError(400, 'Invalid UI update')
  return ops.map((op: unknown) => {
    if (!op || typeof op !== 'object' || Array.isArray(op))
      throw new HttpError(400, 'Invalid UI update')
    const { key, value, who, seq } = op as Record<string, unknown>
    if (!validUiKey(key)) throw new HttpError(400, 'Invalid UI key')
    if (key === UI_REVISION) throw new HttpError(400, 'The UI revision is the server’s')
    if (who !== undefined && who !== 'person' && who !== 'agent' && who !== 'app')
      throw new HttpError(400, 'Invalid UI writer')
    if (seq !== undefined && !Number.isSafeInteger(seq))
      throw new HttpError(400, 'Invalid UI sequence')
    return { key, value: value as JsonValue | undefined, who, seq: seq as number | undefined }
  })
}
const maxUiWriters = 1000
const actionPath = /^\/api\/extensions\/([^/]+)\/actions\/([^/]+)$/
const subscriptionPath = /^\/api\/events\/([0-9a-f-]+)$/
const maxResentSummaryTitleCharacters = 200
const asSent = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonValue
const taskGraphBroadcastIntervalMs = 100
const liveViewMinimumEntries = 150
const minReadEveryMs = 250
const maxReadEveryMs = 24 * 60 * 60_000
type StreamUniqueSubscriptionId = number

interface Connection {
  send: ReturnType<typeof eventStream>['send']
  subscriptions: Map<StreamUniqueSubscriptionId, () => Promise<void>>
  queue: Promise<void>
  ended: boolean
}
function reply(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(data))
}
function failed(response: ServerResponse, error: unknown) {
  if (!response.headersSent)
    reply(response, error instanceof HttpError ? error.status : 500, {
      error: error instanceof HttpError ? error.message : 'Request failed',
    })
  else response.destroy()
}
function eventStream(response: ServerResponse) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  response.write('retry: 500\n\n')
  const stopHeartbeat = every(15000, () => {
    if (!response.destroyed) response.write(': heartbeat\n\n')
  })
  return {
    send: (name: keyof ServerEvents, data: ServerEvents[keyof ServerEvents], sub?: number) => {
      if (!response.destroyed)
        response.write(
          `event: ${name}\n${sub === undefined ? '' : `data: ${sub}\n`}data: ${JSON.stringify(data)}\n\n`,
        )
    },
    end: () => {
      stopHeartbeat()
      response.end()
    },
  }
}
const browserRequest = (request: IncomingMessage) =>
  request.headers['sec-fetch-site'] === 'same-origin' || !!request.headers.origin
const validConversationId = (id: unknown) =>
  id === undefined || (typeof id === 'number' && Number.isSafeInteger(id) && id >= 1)
const argsOf = (data: Record<string, unknown>) =>
  (Object.hasOwn(data, 'args') ? data.args : null) as JsonValue
const readInterval = (againAfterMs: unknown) =>
  typeof againAfterMs === 'number' && Number.isFinite(againAfterMs)
    ? Math.min(maxReadEveryMs, Math.max(minReadEveryMs, againAfterMs))
    : undefined
function readSpec(value: unknown): ReadSpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new HttpError(400, 'Invalid read')
  const read = value as Record<string, unknown>
  const { extension, action, conversation } = read
  if (typeof extension !== 'string' || typeof action !== 'string')
    throw new HttpError(400, 'Invalid read')
  if (!validConversationId(conversation)) throw new HttpError(400, 'Invalid conversation id')
  return {
    extension,
    action,
    args: argsOf(read),
    ...(conversation === undefined ? {} : { conversation: conversation as number }),
  }
}
async function runAction(
  request: IncomingMessage,
  response: ServerResponse,
  extensions: Extensions,
  reads: Reads,
  [, name, key]: RegExpExecArray,
  data: Record<string, unknown>,
) {
  if (!browserRequest(request)) {
    const { error, rev } = reads.refused(403, 'Extension actions require a browser request')
    reply(response, 403, { error, rev })
    return
  }
  const id = data.conversationId as number | undefined
  if (!validConversationId(id)) {
    const { error, rev } = reads.refused(400, 'Invalid conversation id')
    reply(response, 400, { error, rev })
    return
  }
  const args = argsOf(data)
  const { rev, publish } = reads.answering({
    extension: name,
    action: key,
    args,
    ...(id === undefined ? {} : { conversation: id }),
  })
  if (!extensions.action(name, key)) {
    const current = publish({ error: 'Unknown extension action', status: 404 })
    reply(response, 404, {
      error: 'Unknown extension action',
      rev,
      ...(current ? {} : { superseded: true }),
    })
    return
  }
  const controller = new AbortController()
  const cancel = () => {
    if (!response.writableEnded) controller.abort()
  }
  response.once('close', cancel)
  try {
    const result = await extensions.invoke(
      name,
      key,
      args,
      controller.signal,
      id === undefined ? undefined : parseConversationId(id),
      'ui',
      deviceOf(request.headers),
      sourceOf(request.headers),
    )
    const current = publish({ result: result ?? null })
    reply(response, 200, { result, rev, ...(current ? {} : { superseded: true }) })
  } catch (error) {
    const clientLeft = controller.signal.aborted
    const aborted = clientLeft || (error as Error)?.name === 'AbortError'
    if (!aborted) console.error(`Extension action ${name}/${key}:`, error)
    const userFacingActionError = (error instanceof Error ? error.message : String(error)).slice(
      0,
      500,
    )
    const current = clientLeft ? true : publish({ error: userFacingActionError, status: 500 })
    reply(response, 500, {
      error: userFacingActionError,
      rev,
      ...(current ? {} : { superseded: true }),
    })
  } finally {
    response.off('close', cancel)
  }
}

export async function createApi(
  host: PreparedHost,
  opened: OpenHost,
  events: Events,
  system: Awaited<ReturnType<typeof createSystem>>,
  extensions: Extensions,
  access: Access,
  pageConnected: () => void,
) {
  const { harness, root } = opened
  const streams = new Set<() => Promise<void>>()
  const connections = new Map<string, Connection>()
  const reads = createReads(async (spec, signal) => {
    if (!extensions.action(spec.extension, spec.action))
      throw new HttpError(404, 'Unknown extension action')
    return await extensions.invoke(
      spec.extension,
      spec.action,
      spec.args,
      signal,
      spec.conversation === undefined ? undefined : parseConversationId(spec.conversation),
      'ui',
      undefined,
      { source: 'app' },
    )
  })
  let onGraph = () => {}
  const latestCommitGraph: { tasks?: TaskGraph } = {}
  const graph = await harness.observeTaskGraph(
    {
      advance: (call) => {
        if (call.kind !== 'value') return
        latestCommitGraph.tasks = call.value
        onGraph()
      },
      end: () => {},
    },
    context,
  )
  latestCommitGraph.tasks ??= graph.value
  const tasks = () => latestCommitGraph.tasks!
  let sentTasks = asSent(tasks()) as unknown as TaskGraph
  let closed = false
  let summaries: ConversationSummary[] = []
  const projectIndex = conversationIndex(host.home)
  function publishSummaries(next: ConversationSummary[]) {
    const ops = diffRevisions(asSent(summaries), asSent(next))
    if (!ops.length) return
    summaries = next
    projectIndex.update(summaries)
    events.emit('conversationsOps', ops)
  }
  let refreshing = Promise.resolve()
  async function refreshConversations(ids?: Set<ConversationId>) {
    const records = await harness.commit(async (tx) => {
      if (ids)
        return (await Promise.all([...ids].map((id) => tx.conversation(id)))).filter(
          (record) => record !== undefined,
        )
      const scanned = []
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanConversations({}, 256, cursor)
        scanned.push(...page.items)
        cursor = page.next
      } while (cursor !== undefined)
      return scanned
    }, context)
    const refreshed: Omit<ConversationSummary, 'busy'>[] = []
    for (const record of records) {
      const conversation = await harness.conversation(record.id, context)
      if (!conversation) continue
      const agent = await conversation.agent(context)
      const metadata = await harness.snapshot(Metadata, record.id, context)
      if (metadata?.label === EVENT_LOG_LABEL) continue
      const full = metadata?.title ?? metadata?.inputTitle
      const title =
        full && full.length > maxResentSummaryTitleCharacters
          ? shortTitle(full, maxResentSummaryTitleCharacters)
          : full
      refreshed.push({
        id: record.id,
        ...(record.owner ? { parentConversationId: record.owner.conversationId } : {}),
        ...(!record.owner && record.parent ? { branchOf: record.parent } : {}),
        ...(record.owner ? { ownerTaskId: record.owner.taskId } : {}),
        ...(metadata?.label ? { label: metadata.label } : {}),
        ...(metadata?.external ? { external: metadata.external } : {}),
        ...(title ? { title } : {}),
        cwd: agent.cwd,
        ...(metadata?.inputAt === undefined ? {} : { inputAt: metadata.inputAt }),
        ...(metadata?.answerAt === undefined ? {} : { answerAt: metadata.answerAt }),
      })
    }
    const summariesIncludingConcurrentUpdates = ids ? [...summaries] : []
    for (const fresh of refreshed) {
      const summary = {
        ...fresh,
        busy: Object.values(sentTasks.tasks).some(
          (task) => task.conversationId === fresh.id && !task.background,
        ),
      }
      const index = summariesIncludingConcurrentUpdates.findIndex((item) => item.id === summary.id)
      if (index < 0) summariesIncludingConcurrentUpdates.push(summary)
      else summariesIncludingConcurrentUpdates[index] = summary
    }
    publishSummaries(summariesIncludingConcurrentUpdates)
  }
  const scheduleGraph = batch(taskGraphBroadcastIntervalMs, () => {
    const next = asSent(tasks()) as unknown as TaskGraph
    const ops = diffRevisions(sentTasks as unknown as JsonValue, next as unknown as JsonValue)
    if (ops.length) {
      sentTasks = next
      events.emit('tasksOps', ops)
      publishSummaries(
        summaries.map((summary) => ({
          ...summary,
          busy: Object.values(next.tasks).some(
            (task) => task.conversationId === summary.id && !task.background,
          ),
        })),
      )
    }
  })
  onGraph = () => {
    if (!closed) scheduleGraph()
  }
  await refreshConversations()
  projectIndex.update(summaries)
  const unsubscribe = onCommit(harness, (publication) => {
    if (closed) return
    const ids = new Set<ConversationId>()
    for (const change of publication.changes) {
      if (change.type === 'conversation') ids.add(change.value.id)
      if (
        change.type === 'document' &&
        change.conversationId &&
        (change.record.kind === 'ultimate.metadata' ||
          (change.record.kind === 'pi.agent' &&
            (change.kind === 'retire' ||
              change.ops.some((op) => op[0] === 'r' || op[1][0] === 'cwd'))))
      )
        ids.add(change.conversationId)
    }
    if (!ids.size) return
    refreshing = refreshing
      .then(() => refreshConversations(ids))
      .catch(() =>
        events.emit('notice', { level: 'error', message: 'Could not refresh conversation list' }),
      )
  })
  async function stream(request: IncomingMessage, response: ServerResponse) {
    const ui = await harness.watchDoc(UiState, root.id, context)
    const sse = eventStream(response)
    const id = crypto.randomUUID()
    const connection: Connection = {
      send: sse.send,
      subscriptions: new Map(),
      queue: Promise.resolve(),
      ended: false,
    }
    connections.set(id, connection)
    pageConnected()
    const { send } = sse
    send('stream', { id })
    send('system', system.current())
    send('conversations', summaries)
    send('ui', { value: ui!.value })
    ui!.start(async (call) => {
      if (call.kind === 'value') send('uiOps', { ops: call.ops })
    })
    send('tasks', sentTasks)
    events.listeners.add(send)
    const stop = async () => {
      if (connection.ended) return
      connection.ended = true
      connections.delete(id)
      events.listeners.delete(send)
      streams.delete(stop)
      sse.end()
      const established = [...connection.subscriptions.values()]
      connection.subscriptions.clear()
      await Promise.all([ui!.stop(), ...established.map((close) => close())])
    }
    streams.add(stop)
    response.on('close', () => {
      inProcess(
        'the HTTP event stream closes with this process',
        stop().catch((error: unknown) => console.error('Stopping event stream failed:', error)),
      )
    })
    if (request.destroyed || response.destroyed) await stop()
  }
  async function subscribe(
    connection: Connection,
    streamUniqueId: StreamUniqueSubscriptionId,
    id: ConversationId,
    kinds: string[],
    withView: boolean,
  ) {
    const conversation = await harness.conversation(id, context)
    if (!conversation) throw new HttpError(404, 'Unknown conversation')
    const docs: { kind: string; watch: DocumentWatch<JsonObject> }[] = []
    const absent = new Map<string, ConversationDocToken<JsonObject>>()
    const created = new Set<string>()
    const unknown: string[] = []
    const watches: { stop(): Promise<unknown> }[] = []
    let delivered = false
    let stopped = false
    const stopNoticingCreations = onCommit(harness, (publication) => {
      for (const change of publication.changes)
        if (change.type === 'document' && change.kind === 'change' && change.conversationId === id)
          created.add(change.record.kind)
      if (delivered && created.size) queueMicrotask(followCreatedDocs)
    })
    const stop = async () => {
      stopped = true
      stopNoticingCreations()
      await Promise.all(watches.map((watch) => watch.stop()))
    }
    let live: Awaited<ReturnType<typeof conversation.watch>> | undefined
    try {
      for (const kind of new Set(kinds)) {
        const token = extensions.doc(kind)
        if (!token) {
          unknown.push(kind)
          continue
        }
        const watch = await harness.watchDoc(token, id, context)
        if (watch) {
          docs.push({ kind, watch })
          watches.push(watch)
        } else absent.set(kind, token)
      }
      if (!absent.size) stopNoticingCreations()
      if (withView) {
        live = await conversation.watch(context, { min: liveViewMinimumEntries })
        watches.push(live)
      }
    } catch (error) {
      await stop()
      throw error
    }
    if (connection.ended || connection.subscriptions.has(streamUniqueId)) {
      await stop()
      return
    }
    connection.subscriptions.set(streamUniqueId, stop)
    const send = <K extends keyof ServerEvents>(name: K, data: ServerEvents[K]) =>
      connection.send(name, data, streamUniqueId)
    for (const kind of unknown)
      connection.send('notice', {
        level: 'warning',
        message: `Unknown extension document: ${kind}`,
      })
    function deliverSnapshotsThenOps() {
      if (live) {
        send('view', live.value)
        live.start(async (call) => {
          if (call.kind === 'value') send('ops', call.ops)
        })
      }
      for (const doc of docs) follow(doc.kind, doc.watch)
      for (const [kind, token] of absent) send('doc', { kind, value: token.definition.initial() })
    }
    function follow(kind: string, watch: DocumentWatch<JsonObject>) {
      send('doc', { kind, value: watch.value })
      watch.start(async (call) => {
        if (call.kind === 'value') send('docOps', { kind, ops: call.ops })
      })
    }
    function followCreatedDocs() {
      if (stopped) return
      for (const kind of created) {
        const token = absent.get(kind)
        if (!token) continue
        absent.delete(kind)
        inProcess(
          'a document watch belongs to this event stream',
          harness
            .watchDoc(token, id, context)
            .then(async (watch) => {
              if (!watch) absent.set(kind, token)
              else if (stopped) await watch.stop()
              else {
                watches.push(watch)
                follow(kind, watch)
              }
              if (!absent.size) stopNoticingCreations()
            })
            .catch((error: unknown) =>
              connection.send('notice', {
                level: 'error',
                message: `Could not watch ${kind}: ${String(error)}`,
              }),
            ),
        )
      }
      created.clear()
    }
    try {
      deliverSnapshotsThenOps()
      delivered = true
      followCreatedDocs()
    } catch (error) {
      connection.subscriptions.delete(streamUniqueId)
      await stop()
      throw error
    }
  }
  function subscribeRead(
    connection: Connection,
    streamUniqueId: StreamUniqueSubscriptionId,
    spec: ReadSpec,
    againAfterMs: number | undefined,
    fromBrowser: boolean,
  ) {
    if (connection.ended || connection.subscriptions.has(streamUniqueId)) return
    const send = (event: ServerEvents['read']) => connection.send('read', event, streamUniqueId)
    if (!fromBrowser) {
      send(reads.refused(403, 'Extension actions require a browser request'))
      connection.subscriptions.set(streamUniqueId, async () => {})
      return
    }
    const stop = reads.subscribe(spec, againAfterMs, send)
    connection.subscriptions.set(streamUniqueId, async () => stop())
  }
  function conversationParam(value: unknown) {
    const id = value === undefined ? root.id : Number(value)
    if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, 'Invalid conversation id')
    return parseConversationId(id)
  }
  return {
    conversations() {
      return summaries
    },
    pages: () => connections.size,
    reads: () => reads.size(),
    async handle(request: IncomingMessage, response: ServerResponse) {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/api/')) return false
      const json = (status: number, data: unknown) => reply(response, status, data)
      try {
        if (
          !(await admit(request, new URL(system.current().process.url).port || '80', access.rules))
        )
          throw new HttpError(403, 'Forbidden')
        if (request.method === 'GET' && url.pathname === '/api/events') {
          await stream(request, response)
          return true
        }
        const subscription = subscriptionPath.exec(url.pathname)
        if (subscription && request.method === 'POST') {
          const connection = connections.get(subscription[1])
          if (!connection) throw new HttpError(410, 'Event stream ended')
          const data: Partial<Record<keyof SubscriptionsRequest, unknown>> = await body(
            request,
            MAX_SUBSCRIPTION_BATCH_BYTES,
            MAX_SUBSCRIPTION_BATCH_BYTES * 4,
          )
          const opens = data.subscribe ?? []
          const closes = data.unsubscribe ?? []
          if (
            !Array.isArray(opens) ||
            !Array.isArray(closes) ||
            !closes.every(Number.isSafeInteger)
          )
            throw new HttpError(400, 'Invalid subscriptions')
          const closing = new Set(closes as number[])
          const specs = opens
            .map((item: unknown) => {
              if (typeof item !== 'object' || item === null || Array.isArray(item))
                throw new HttpError(400, 'Invalid subscription')
              const spec = item as Record<string, unknown>
              if (!Number.isSafeInteger(spec.sub))
                throw new HttpError(400, 'Invalid subscription id')
              return spec as Record<string, unknown> & { sub: number }
            })
            .filter(({ sub }) => !closing.has(sub))
          const run = connection.queue.then(async () => {
            if (connection.ended) throw new HttpError(410, 'Event stream ended')
            const refused: Record<number, number> = {}
            const keepsSharedReadsRunning = specs.filter((spec) => spec.read !== undefined)
            for (const spec of keepsSharedReadsRunning)
              try {
                subscribeRead(
                  connection,
                  spec.sub,
                  readSpec(spec.read),
                  readInterval(spec.every),
                  browserRequest(request),
                )
              } catch (error) {
                refused[spec.sub] = error instanceof HttpError ? error.status : 500
              }
            for (const sub of closing) {
              const close = connection.subscriptions.get(sub)
              connection.subscriptions.delete(sub)
              if (close) await close()
            }
            await Promise.all(
              specs
                .filter((spec) => spec.read === undefined)
                .map(async (spec) => {
                  try {
                    const docs = spec.docs ?? []
                    if (!Array.isArray(docs) || !docs.every((kind) => typeof kind === 'string'))
                      throw new HttpError(400, 'Invalid document kinds')
                    const conversation = conversationParam(spec.conversation)
                    await subscribe(connection, spec.sub, conversation, docs, spec.view !== false)
                  } catch (error) {
                    if (!(error instanceof HttpError))
                      console.error(`Subscribing to ${JSON.stringify(spec)} failed:`, error)
                    refused[spec.sub] = error instanceof HttpError ? error.status : 500
                  }
                }),
            )
            return refused
          })
          connection.queue = run.then(
            () => undefined,
            () => undefined,
          )
          json(200, { ok: true, refused: await run } satisfies SubscriptionsAnswer)
          return true
        }
        const history = /^\/api\/conversations\/(\d+)\/history$/.exec(url.pathname)
        if (request.method === 'GET' && history) {
          const id = parseConversationId(Number(history[1]))
          const before = parseEntryId(Number(url.searchParams.get('before')))
          const revealLowerBoundEntryId = parseEntryId(
            url.searchParams.has('after') ? Number(url.searchParams.get('after')) : 0,
          )
          if (
            !Number.isSafeInteger(id) ||
            id < 1 ||
            !Number.isSafeInteger(before) ||
            before < 1 ||
            !Number.isSafeInteger(revealLowerBoundEntryId) ||
            revealLowerBoundEntryId < 0
          )
            throw new HttpError(400, 'Invalid history cursor or conversation id')
          const conversation = await harness.conversation(id, context)
          if (!conversation) throw new HttpError(404, 'Unknown conversation')
          const size = revealLowerBoundEntryId ? 512 : 64
          const page = await conversation.entries(
            {
              maxEntryId: offsetEntryId(before, -1),
              ...(revealLowerBoundEntryId && { minEntryId: revealLowerBoundEntryId }),
            },
            size + 1,
            undefined,
            context,
          )
          const entries = page.items.slice(0, size)
          json(200, {
            entries,
            before: page.items.length > size ? entries.at(-1)!.id : undefined,
          })
          return true
        }
        if (request.method === 'GET' && url.pathname === '/api/models') {
          json(200, await listModels(host.modelRuntime))
          return true
        }
        if (request.method !== 'POST') throw new HttpError(404, 'Unknown endpoint')
        const action = actionPath.exec(url.pathname)
        const mayCarryMedia = action || /^\/api\/conversations\/\d+\/submit$/.test(url.pathname)
        const mediaBodyLimitBytes = 12 * 1024 * 1024
        const data = await body(request, mayCarryMedia ? mediaBodyLimitBytes : undefined)
        if (action) {
          await runAction(request, response, extensions, reads, action, data)
          return true
        }
        if (url.pathname === '/api/ui') {
          const { tab } = data
          const requested = uiOps(data.ops)
          if (new Set(requested.map(({ key }) => key)).size > maxUiWriters)
            throw new HttpError(413, 'Too many UI keys in one write')
          if (tab !== undefined && (typeof tab !== 'string' || tab.length > 64))
            throw new HttpError(400, 'Invalid UI tab')
          const by = { ...sourceOf(request.headers), ...deviceOf(request.headers) }
          const rev = await root.commit(async (tx) => {
            const writers = await tx.doc(UiWriters, root.id)
            const ops = requested.filter(({ key, seq }) => {
              if (tab === undefined || seq === undefined) return true
              const writer = `${tab} ${key}`
              if ((writers[writer] ?? -Infinity) >= seq) return false
              delete writers[writer]
              writers[writer] = seq
              return true
            })
            const writtenNow = new Set(requested.map(({ key }) => `${tab} ${key}`))
            const older = Object.keys(writers).filter((writer) => !writtenNow.has(writer))
            const overCap = Object.keys(writers).length - maxUiWriters
            for (const writer of older.slice(0, Math.max(0, overCap))) delete writers[writer]
            const value = await tx.doc(UiState, root.id)
            const written = new Map<string, JsonValue | undefined>()
            const stored = (key: string) =>
              written.has(key)
                ? written.get(key)
                : Object.hasOwn(value, key)
                  ? value[key]
                  : undefined
            const changes = ops.map(({ key, value: after, who }) => {
              const change = uiChange(who ? { ...by, source: who } : by, {
                key,
                value: after,
                previous: stored(key),
              })
              written.set(key, after)
              return change
            })
            const next = { ...value, ...Object.fromEntries(written) }
            for (const [key, item] of written) if (item === undefined) delete next[key]
            if (Buffer.byteLength(JSON.stringify(next)) > 256 * 1024)
              throw new HttpError(413, 'UI state too large')
            for (const change of changes) if (change) await emit(tx, ChangedEvent, change)
            for (const [key, item] of written)
              if (item === undefined) delete value[key]
              else value[key] = item
            const previous = value[UI_REVISION]
            const revisionInSameCommit = (typeof previous === 'number' ? previous : 0) + 1
            value[UI_REVISION] = revisionInSameCommit
            return revisionInSameCommit
          }, context)
          json(200, { ok: true, rev })
          return true
        }
        if (url.pathname === '/api/restart') {
          const error =
            (await extensions.restartRefusal()) ??
            (await requestSwap(async (generation) => {
              json(202, { ok: true, generation })
            }, host.build()))
          if (!response.writableEnded) json(500, { ok: false, error })
          return true
        }
        if (url.pathname === '/api/conversations') {
          const cwd = data.cwd === undefined ? host.projectRoot : text(data.cwd, 'cwd')
          const title = data.title === undefined ? undefined : text(data.title, 'title')
          const created = await harness.createConversation(
            {
              ownership: { kind: 'ownerless' },
              agent: { cwd, ...(await hostDefault(host)) },
            },
            context,
          )
          if (title)
            await created.commit(async (tx) => {
              ;(await tx.doc(Metadata, created.id)).title = title
            }, context)
          await refreshing
          json(201, { id: created.id })
          return true
        }
        const cancel = /^\/api\/conversations\/(\d+)\/inbox\/(\d+)\/cancel$/.exec(url.pathname)
        if (cancel) {
          const submission = await harness.submission(Number(cancel[2]) as SubmissionId, context)
          if (
            !submission ||
            (await submission.status(context)).conversationId !== Number(cancel[1])
          )
            throw new HttpError(404, 'Unknown queued input')
          const outcome = await submission.abort(context)
          if (outcome !== 'aborted') {
            const settled = await submission.status(context)
            if (
              settled.status !== 'unanswered' ||
              settled.reason !== 'aborted' ||
              settled.entry !== undefined
            )
              throw new HttpError(409, 'Input is already being processed or has finished')
          }
          json(200, { ok: true })
          return true
        }
        const match = /^\/api\/conversations\/(\d+)\/(submit|abort|configure|compact)$/.exec(
          url.pathname,
        )
        if (match) {
          const conversation = await harness.conversation(
            parseConversationId(Number(match[1])),
            context,
          )
          if (!conversation) throw new HttpError(404, 'Unknown conversation')
          switch (match[2]) {
            case 'submit': {
              if (
                data.whenBusy !== undefined &&
                data.whenBusy !== 'steer' &&
                data.whenBusy !== 'followUp'
              )
                throw new HttpError(400, 'Invalid whenBusy')
              if (typeof data.text !== 'string') throw new HttpError(400, 'Expected text')
              const length = data.text.length
              const images = data.images === undefined ? [] : data.images
              if (!Array.isArray(images)) throw new HttpError(400, 'Expected images array')
              if (images.length > maxImages) throw new HttpError(413, `At most ${maxImages} images`)
              const blocks = images.map((image: unknown) => {
                if (!image || typeof image !== 'object') throw new HttpError(400, 'Invalid image')
                const { data: encoded, mimeType } = image as Record<string, unknown>
                if (
                  typeof mimeType !== 'string' ||
                  !imageMimeTypes.includes(mimeType) ||
                  typeof encoded !== 'string' ||
                  !encoded ||
                  encoded.length % 4 !== 0 ||
                  !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
                )
                  throw new HttpError(400, 'Expected supported image MIME type and base64 data')
                if (Buffer.byteLength(encoded, 'base64') > maxImageBytes)
                  throw new HttpError(413, 'Image exceeds 2 MiB')
                if (Buffer.from(encoded, 'base64').toString('base64') !== encoded)
                  throw new HttpError(400, 'Invalid image base64 data')
                return { type: 'image' as const, data: encoded, mimeType }
              })
              if (!data.text.trim() && !blocks.length)
                throw new HttpError(400, 'Expected text or images')
              const expanded = data.text.startsWith('/skill:')
                ? expandSkillCommand(
                    data.text,
                    host.skills((await conversation.agent(context)).cwd ?? host.projectRoot),
                  )
                : data.text
              const content = blocks.length
                ? [
                    ...(expanded.trim() ? [{ type: 'text' as const, text: expanded }] : []),
                    ...blocks,
                  ]
                : expanded
              const submission = await conversation.submit(
                { type: 'input', content, whenBusy: data.whenBusy },
                context,
              )
              const inputAlreadyCommitted = await submission.status(context)
              await harness.commit(
                (tx) =>
                  emit(tx, UserInputEvent, {
                    conversation: conversation.id,
                    kind:
                      inputAlreadyCommitted.status !== 'queued'
                        ? 'prompt'
                        : data.whenBusy === 'steer'
                          ? 'steer'
                          : 'follow-up',
                    ...(inputAlreadyCommitted.entry === undefined
                      ? { submission: submission.id }
                      : { entry: inputAlreadyCommitted.entry }),
                    length,
                    ...deviceOf(request.headers),
                  }),
                context,
              )
              json(202, { submissionId: submission.id })
              break
            }
            case 'abort': {
              abortUntilIdle: for (;;) {
                const ownTasksPreservingQueuedInputs = (
                  await harness.inspect(context)
                ).tasks.filter(
                  ({ record }) =>
                    record.conversationId === conversation.id &&
                    !record.owner &&
                    !record.background,
                )
                if (ownTasksPreservingQueuedInputs.length === 0) break abortUntilIdle
                for (const { record } of ownTasksPreservingQueuedInputs) {
                  await harness.abortTask(record.id, context)
                  await harness.waitForTask(record.id, context)
                }
              }
              json(200, { ok: true })
              break
            }
            case 'configure': {
              if ((await harness.snapshot(Metadata, conversation.id, context))?.external)
                throw new HttpError(409, 'Set the model through Antigravity’s ACP controls')
              const configure: ConfigureRequest = {}
              if (data.model !== undefined) {
                if (!data.model || typeof data.model !== 'object')
                  throw new HttpError(400, 'Invalid model')
                const model = data.model as Record<string, unknown>
                const provider = text(model.provider, 'model.provider'),
                  modelId = text(model.modelId, 'model.modelId')
                if (
                  !(await host.models()).some(
                    (candidate) =>
                      candidate.available &&
                      candidate.provider === provider &&
                      candidate.id === modelId,
                  )
                )
                  throw new HttpError(400, 'Model is not available')
                configure.model = { provider, modelId }
              }
              if (data.thinkingLevel !== undefined || configure.model) {
                const agent = await conversation.agent(context)
                const ref = configure.model ?? agent.model
                const model = ref && host.model(ref)
                if (!model) throw new HttpError(400, 'No model to set a thinking level for')
                if (data.thinkingLevel === undefined)
                  configure.thinkingLevel = clampThinkingLevel(model, agent.thinkingLevel)
                else {
                  configure.thinkingLevel = getSupportedThinkingLevels(model).find(
                    (level) => level === data.thinkingLevel,
                  )
                  if (!configure.thinkingLevel)
                    throw new HttpError(
                      400,
                      `${model.provider}/${model.id} does not support thinking level ${JSON.stringify(data.thinkingLevel)}`,
                    )
                }
              }
              await conversation.configure(configure, context)
              json(200, { ok: true })
              break
            }
            case 'compact':
              if ((await harness.snapshot(Metadata, conversation.id, context))?.external)
                throw new HttpError(409, 'ACP conversations cannot be compacted')
              if (data.instructions !== undefined && typeof data.instructions !== 'string')
                throw new HttpError(400, 'Invalid instructions')
              json(202, {
                taskId: await conversation.compact(data.instructions, context),
              })
              break
          }
          return true
        }
        throw new HttpError(404, 'Unknown endpoint')
      } catch (error) {
        failed(response, error)
      }
      return true
    },
    async close() {
      closed = true
      unsubscribe()
      graph.detach()
      scheduleGraph.cancel()
      await Promise.all([...streams].map((stop) => stop()))
      await refreshing
      await projectIndex.flush()
    },
  }
}
