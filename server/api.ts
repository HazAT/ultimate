import type { IncomingMessage, ServerResponse } from 'node:http'
import { onCommit } from '../lib/commits.ts'
import type {
  ConversationId,
  Cursor,
  DocumentWatch,
  EntryId,
  JsonObject,
  SubmissionId,
  TaskGraph,
} from '@earendil-works/pi-durable'
import type { ServerEvents, ConversationSummary, ConfigureRequest } from '../shared/protocol.ts'
import { UI_REVISION, imageMimeTypes, maxImageBytes, maxImages } from '../shared/protocol.ts'
import { listModels } from './models.ts'
import { expandSkillCommand } from './skills.ts'
import type { Extensions } from './extensions.ts'
import { context } from './harness.ts'
import type { OpenHost, PreparedHost } from './harness.ts'
import type { createSystem } from './system.ts'
import { requestSwap } from './supervisor-protocol.ts'
import { UiState } from './ui-state.ts'
import type { JsonValue } from '@earendil-works/chord'
import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { Metadata } from './metadata.ts'
import { EVENT_LOG_LABEL, emit } from './events.ts'
import { UserInputEvent } from '../shared/events.ts'
import { admit, deviceOf } from './request-security.ts'
import type { Access } from './request-security.ts'
import { conversationIndex } from './project.ts'
import { shortTitle } from '../lib/title.ts'

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
): Promise<Record<string, unknown>> {
  let data = ''
  request.setEncoding('utf8')
  for await (const chunk of request) {
    data += chunk.toString()
    if (Buffer.byteLength(data) > limit) throw new HttpError(413, 'Request too large')
  }
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
const validUiKey = (key: unknown) =>
  typeof key === 'string' && key.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(key)
const actionPath = /^\/api\/extensions\/([^/]+)\/actions\/([^/]+)$/
const subscriptionPath = /^\/api\/events\/([0-9a-f-]+)\/(\d+)$/
/** One open `/api/events` stream: a browser tab's only long-lived request, carrying all its subscriptions. */
interface Connection {
  send: ReturnType<typeof eventStream>['send']
  subscriptions: Map<number, () => Promise<void>>
  /** Subscriptions closed before they were open, so an open that arrives after its close is not started. */
  closed: Set<number>
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
/**
 * Start a server-sent event stream; `end` stops its heartbeat and closes it. An event of a subscription carries its id
 * on its first data line.
 */
function eventStream(response: ServerResponse) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  response.write('retry: 500\n\n')
  const heartbeat = setInterval(() => {
    if (!response.destroyed) response.write(': heartbeat\n\n')
  }, 15000)
  return {
    send: (name: keyof ServerEvents, data: ServerEvents[keyof ServerEvents], sub?: number) => {
      if (!response.destroyed)
        response.write(
          `event: ${name}\n${sub === undefined ? '' : `data: ${sub}\n`}data: ${JSON.stringify(data)}\n\n`,
        )
    },
    end: () => {
      clearInterval(heartbeat)
      response.end()
    },
  }
}
/** `POST /api/extensions/:name/actions/:action`: answers `{ result }`, or the action's error message. */
async function runAction(
  request: IncomingMessage,
  response: ServerResponse,
  extensions: Extensions,
  [, name, key]: RegExpExecArray,
  data: Record<string, unknown>,
) {
  if (request.headers['sec-fetch-site'] !== 'same-origin' && !request.headers.origin)
    throw new HttpError(403, 'Extension actions require a browser request')
  if (!extensions.action(name, key)) throw new HttpError(404, 'Unknown extension action')
  const id = data.conversationId
  if (id !== undefined && (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1))
    throw new HttpError(400, 'Invalid conversation id')
  const controller = new AbortController()
  const cancel = () => {
    if (!response.writableEnded) controller.abort()
  }
  response.once('close', cancel)
  try {
    // Missing args mean none, so `curl -d '{}'` and agents can call argument-free actions.
    const args = (Object.hasOwn(data, 'args') ? data.args : {}) as JsonValue
    const result = await extensions.invoke(
      name,
      key,
      args,
      controller.signal,
      id,
      'ui',
      deviceOf(request.headers),
    )
    reply(response, 200, { result })
  } catch (error) {
    // An aborted action is the client leaving (a newer call, an unmount), not a fault.
    if (!controller.signal.aborted && (error as Error)?.name !== 'AbortError')
      console.error(`Extension action ${name}/${key}:`, error)
    // The message is the action author's; the UI shows it, so a setup problem can say what is missing.
    const message = error instanceof Error ? error.message : String(error)
    reply(response, 500, { error: message.slice(0, 500) })
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
) {
  const { harness, root } = opened
  const streams = new Set<() => Promise<void>>()
  const connections = new Map<string, Connection>()
  // The live task graph, kept current synchronously as commits are adopted; its changes are sent at most every 100 ms.
  let onGraph = () => {}
  // A change can arrive before the observation resolves; it is newer than the observation's value.
  const latest: { tasks?: TaskGraph } = {}
  const graph = await harness.observeTaskGraph(
    {
      advance: (call) => {
        if (call.kind !== 'value') return
        latest.tasks = call.value
        onGraph()
      },
      end: () => {},
    },
    context,
  )
  latest.tasks ??= graph.value
  const tasks = () => latest.tasks!
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let summaries: ConversationSummary[] = []
  const projectIndex = conversationIndex(host.home)
  const indexListener: Parameters<typeof events.listeners.add>[0] = (name, data) => {
    if (name === 'conversations') projectIndex.update(data as ConversationSummary[])
  }
  events.listeners.add(indexListener)
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
      // Every list the user sees (sidebar, search, @ultimate, the cloud front page) comes from these summaries.
      if (metadata?.label === EVENT_LOG_LABEL) continue
      // Older subagents were titled with their whole prompt; every switch resends this list, so long titles are cut.
      const full = metadata?.title ?? metadata?.inputTitle
      const title = full && full.length > 200 ? shortTitle(full, 200) : full
      refreshed.push({
        id: record.id,
        ...(record.owner ? { parentConversationId: record.owner.conversationId } : {}),
        ...(!record.owner && record.parent ? { branchOf: record.parent } : {}),
        ...(record.owner ? { ownerTaskId: record.owner.taskId } : {}),
        ...(metadata?.label ? { label: metadata.label } : {}),
        ...(title ? { title } : {}),
        cwd: agent.cwd,
        ...(metadata?.inputAt === undefined ? {} : { inputAt: metadata.inputAt }),
        ...(metadata?.answerAt === undefined ? {} : { answerAt: metadata.answerAt }),
      })
    }
    // Merged into the current list with busy from the current graph, so updates made during the awaits above survive.
    const next = ids ? [...summaries] : []
    for (const fresh of refreshed) {
      const summary = {
        ...fresh,
        busy: Object.values(tasks().tasks).some(
          (task) => task.conversationId === fresh.id && !task.background,
        ),
      }
      const index = next.findIndex((item) => item.id === summary.id)
      if (index < 0) next.push(summary)
      else next[index] = summary
    }
    if (JSON.stringify(next) !== JSON.stringify(summaries)) {
      summaries = next
      events.emit('conversations', summaries)
    }
  }
  await refreshConversations()
  projectIndex.update(summaries)
  let lastGraph = JSON.stringify(tasks())
  onGraph = () => {
    if (closed || timer) return
    timer = setTimeout(() => {
      timer = undefined
      const graphJson = JSON.stringify(tasks())
      if (graphJson !== lastGraph) {
        lastGraph = graphJson
        events.emit('tasks', tasks())
        const next = summaries.map((summary) => ({
          ...summary,
          busy: Object.values(tasks().tasks).some(
            (task) => task.conversationId === summary.id && !task.background,
          ),
        }))
        if (JSON.stringify(next) !== JSON.stringify(summaries)) {
          summaries = next
          events.emit('conversations', summaries)
        }
      }
    }, 100)
  }
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
  /** Open the tab's stream: its id, then the state every tab shares, then whatever it subscribes. */
  async function stream(request: IncomingMessage, response: ServerResponse) {
    const ui = await harness.watchDoc(UiState, root.id, context)
    const sse = eventStream(response)
    const id = crypto.randomUUID()
    const connection: Connection = {
      send: sse.send,
      subscriptions: new Map(),
      closed: new Set(),
      ended: false,
    }
    connections.set(id, connection)
    const { send } = sse
    send('stream', { id })
    send('system', system.current())
    send('conversations', summaries)
    send('ui', { value: ui!.value })
    ui!.start(async (call) => {
      if (call.kind === 'value') send('uiOps', { ops: call.ops })
    })
    send('tasks', tasks())
    events.listeners.add(send)
    const stop = async () => {
      if (connection.ended) return
      connection.ended = true
      connections.delete(id)
      events.listeners.delete(send)
      streams.delete(stop)
      await ui!.stop()
      await Promise.all([...connection.subscriptions.values()].map((close) => close()))
      sse.end()
    }
    streams.add(stop)
    response.on('close', () => {
      void stop().catch((error: unknown) => console.error('Stopping event stream failed:', error))
    })
    if (request.destroyed || response.destroyed) await stop()
  }
  /**
   * Stream a conversation's view (when `view`) and documents on `connection` as subscription `sub`: snapshots first,
   * then ops. Its id is the client's; an id is never reused, so its events never mix with a replaced subscription's.
   */
  async function subscribe(
    connection: Connection,
    sub: number,
    id: ConversationId,
    kinds: string[],
    withView: boolean,
  ) {
    const conversation = await harness.conversation(id, context)
    if (!conversation) throw new HttpError(404, 'Unknown conversation')
    const docs: { kind: string; watch: DocumentWatch<JsonObject> }[] = []
    const unknown: string[] = []
    const watches: { stop(): Promise<unknown> }[] = []
    const stop = async () => {
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
        await conversation.commit(async (tx) => {
          await tx.doc(token, id)
        }, context)
        const watch = await harness.watchDoc(token, id, context)
        if (watch) {
          docs.push({ kind, watch })
          watches.push(watch)
        }
      }
      if (withView) {
        // Pi's window: the newest 150 entries, growing to 300 before its oldest leave; `/history` pages the rest.
        live = await conversation.watch(context, { min: 150 })
        watches.push(live)
      }
    } catch (error) {
      await stop()
      throw error
    }
    // The stream ended, or the client closed or reused this id, while its watches opened.
    if (connection.ended || connection.closed.has(sub) || connection.subscriptions.has(sub)) {
      await stop()
      return
    }
    connection.subscriptions.set(sub, stop)
    const send = <K extends keyof ServerEvents>(name: K, data: ServerEvents[K]) =>
      connection.send(name, data, sub)
    for (const kind of unknown)
      connection.send('notice', {
        level: 'warning',
        message: `Unknown extension document: ${kind}`,
      })
    if (live) {
      send('view', live.value)
      live.start(async (call) => {
        if (call.kind === 'value') send('ops', call.ops)
      })
    }
    for (const doc of docs) {
      send('doc', { kind: doc.kind, value: doc.watch.value })
      doc.watch.start(async (call) => {
        if (call.kind === 'value') send('docOps', { kind: doc.kind, ops: call.ops })
      })
    }
  }
  function conversationParam(value: unknown) {
    const id = value === undefined ? root.id : Number(value)
    if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, 'Invalid conversation id')
    return id as ConversationId
  }
  return {
    conversations() {
      return summaries
    },
    /** Open browser tabs: each holds one event stream. */
    pages: () => connections.size,
    async handle(request: IncomingMessage, response: ServerResponse) {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/api/')) return false
      const json = (status: number, data: unknown) => reply(response, status, data)
      try {
        // Local-only does not mean safe from cross-origin browser requests.
        if (
          !(await admit(request, new URL(system.current().process.url).port || '80', access.rules))
        )
          throw new HttpError(403, 'Forbidden')
        if (request.method === 'GET' && url.pathname === '/api/events') {
          await stream(request, response)
          return true
        }
        const subscription = subscriptionPath.exec(url.pathname)
        if (subscription && (request.method === 'POST' || request.method === 'DELETE')) {
          const connection = connections.get(subscription[1])
          if (!connection) throw new HttpError(410, 'Event stream ended')
          const sub = Number(subscription[2])
          if (request.method === 'DELETE') {
            const close = connection.subscriptions.get(sub)
            connection.subscriptions.delete(sub)
            // Not open (yet): its POST, still opening or not arrived, must not start it.
            if (close) await close()
            else connection.closed.add(sub)
          } else {
            const data = await body(request)
            const docs = data.docs ?? []
            if (!Array.isArray(docs) || !docs.every((kind) => typeof kind === 'string'))
              throw new HttpError(400, 'Invalid document kinds')
            await subscribe(
              connection,
              sub,
              conversationParam(data.conversation),
              docs,
              data.view !== false,
            )
          }
          json(200, { ok: true })
          return true
        }
        const history = /^\/api\/conversations\/(\d+)\/history$/.exec(url.pathname)
        if (request.method === 'GET' && history) {
          const id = Number(history[1])
          const before = Number(url.searchParams.get('before'))
          // `after` bounds the page from below, so a reveal reads down to one entry in large pages.
          const after = url.searchParams.has('after') ? Number(url.searchParams.get('after')) : 0
          if (
            !Number.isSafeInteger(id) ||
            id < 1 ||
            !Number.isSafeInteger(before) ||
            before < 1 ||
            !Number.isSafeInteger(after) ||
            after < 0
          )
            throw new HttpError(400, 'Invalid history cursor or conversation id')
          const conversation = await harness.conversation(id as ConversationId, context)
          if (!conversation) throw new HttpError(404, 'Unknown conversation')
          const size = after ? 512 : 64
          const page = await conversation.entries(
            { maxEntryId: (before - 1) as EntryId, ...(after && { minEntryId: after as EntryId }) },
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
        // Submissions carry images and actions can carry media (a voice recording); other commands stay small.
        const data = await body(
          request,
          action || /^\/api\/conversations\/\d+\/submit$/.test(url.pathname)
            ? 12 * 1024 * 1024
            : undefined,
        )
        if (action) {
          await runAction(request, response, extensions, action, data)
          return true
        }
        if (url.pathname === '/api/ui') {
          const set = data.set === undefined ? {} : data.set
          const remove = data.delete === undefined ? [] : data.delete
          if (!set || typeof set !== 'object' || Array.isArray(set) || !Array.isArray(remove))
            throw new HttpError(400, 'Invalid UI update')
          if (!Object.keys(set).every(validUiKey) || !remove.every(validUiKey))
            throw new HttpError(400, 'Invalid UI key')
          if (UI_REVISION in set || remove.includes(UI_REVISION))
            throw new HttpError(400, 'The UI revision is the server’s')
          const rev = await root.commit(async (tx) => {
            const value = await tx.doc(UiState, root.id)
            const next = { ...value, ...(set as Record<string, JsonValue>) }
            for (const key of remove) delete next[key]
            if (Buffer.byteLength(JSON.stringify(next)) > 256 * 1024)
              throw new HttpError(413, 'UI state too large')
            for (const [key, item] of Object.entries(set)) value[key] = item as JsonValue
            for (const key of remove) delete value[key]
            // Counted in the write's own commit, so a client knows which stream snapshot first carries it.
            const previous = value[UI_REVISION]
            const counted = (typeof previous === 'number' ? previous : 0) + 1
            value[UI_REVISION] = counted
            return counted
          }, context)
          json(200, { ok: true, rev })
          return true
        }
        if (url.pathname === '/api/restart') {
          const error = await requestSwap(async (generation) => {
            json(202, { ok: true, generation })
          }, host.build())
          if (!response.writableEnded) json(500, { ok: false, error })
          return true
        }
        if (url.pathname === '/api/conversations') {
          const cwd = data.cwd === undefined ? host.projectRoot : text(data.cwd, 'cwd')
          const title = data.title === undefined ? undefined : text(data.title, 'title')
          const agent = await root.agent(context)
          const created = await harness.createConversation(
            {
              ownership: { kind: 'ownerless' },
              agent: { cwd, model: agent.model, thinkingLevel: agent.thinkingLevel },
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
            Number(match[1]) as ConversationId,
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
              // `/skill:name args` sends the skill's instructions with the request, as Pi does.
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
              // Pi admits the input in a commit with no hook for steers and follow-ups, so the event commits right
              // after it: a crash in between loses the event, never the input.
              const admitted = await submission.status(context)
              await harness.commit(
                (tx) =>
                  emit(tx, UserInputEvent, {
                    conversation: conversation.id,
                    kind:
                      admitted.status !== 'queued'
                        ? 'prompt'
                        : data.whenBusy === 'steer'
                          ? 'steer'
                          : 'follow-up',
                    ...(admitted.entry === undefined
                      ? { submission: submission.id }
                      : { entry: admitted.entry }),
                    length,
                    ...deviceOf(request.headers),
                  }),
                context,
              )
              json(202, { submissionId: submission.id })
              break
            }
            case 'abort': {
              // Stop aborts the conversation's own tasks (each cascades to the work it owns) instead of calling
              // Conversation.abort(), which also withdraws queued inputs: queued follow-ups stay, and Pi places them
              // with the next input, ahead of it. Repeated, since a run ending meanwhile starts the next with them.
              for (;;) {
                const own = (await harness.inspect(context)).tasks.filter(
                  ({ record }) =>
                    record.conversationId === conversation.id &&
                    !record.owner &&
                    !record.background,
                )
                if (own.length === 0) break
                for (const { record } of own) {
                  await harness.abortTask(record.id, context)
                  await harness.waitForTask(record.id, context)
                }
              }
              json(200, { ok: true })
              break
            }
            case 'configure': {
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
              // Pi's policy: a requested level must suit the model; a new model clamps the current one.
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
      clearTimeout(timer)
      await Promise.all([...streams].map((stop) => stop()))
      await refreshing
      events.listeners.delete(indexListener)
      await projectIndex.flush()
    },
  }
}
