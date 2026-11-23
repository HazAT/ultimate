import type { ReadEvent, ReadSpec, ServerEvents } from '../../shared/protocol.ts'
import { createReads } from '../../server/reads.ts'
import type { EventSourceLike } from '../../web/src/sdk/store.ts'

let streams = 0
export class FakeSource extends EventTarget implements EventSourceLike {
  readyState = 0
  closed = false
  readonly url: string
  /** The id of the stream the server opened, as its `stream` event told the store. */
  id?: string
  constructor(url: string) {
    super()
    this.url = url
  }
  close() {
    this.closed = true
    this.readyState = 2
    this.dispatchEvent(new Event('fake-close'))
  }
  /** The server answered: a new stream (also after a drop), which sends its id first. */
  open() {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
    this.id = `stream-${++streams}`
    this.send('stream', { id: this.id })
  }
  /** A dropped connection the browser retries (`closed: false`), or one the server refused. */
  drop(closed = false) {
    this.readyState = closed ? 2 : 0
    this.dispatchEvent(new Event('fake-close'))
    this.dispatchEvent(new Event('error'))
  }
  /** An event of the stream, or with `sub` one of its subscriptions, which carries the id on its first data line. */
  send<K extends keyof ServerEvents>(name: K, data: ServerEvents[K], sub?: number) {
    const json = JSON.stringify(data)
    this.dispatchEvent(
      new MessageEvent(name, { data: sub === undefined ? json : `${sub}\n${json}` }),
    )
  }
}

/** A subscription the store opened, as the server keeps it. */
export interface FakeSubscription {
  stream: string
  sub: number
  conversation?: number
  docs: string[]
  view: boolean
  /** Closed by the store, or with its stream. */
  readonly closed: boolean
  send<K extends 'view' | 'ops' | 'doc' | 'docOps'>(name: K, data: ServerEvents[K]): void
}

/** A read subscription the store opened; the fake server answers it through the test's own action fetch. */
export interface FakeRead {
  stream: string
  sub: number
  read: ReadSpec
  every?: number
  readonly closed: boolean
}

type ActionFetch = (path: string, init: RequestInit) => Response | Promise<Response>
let answeringReads: ActionFetch | undefined
const servers = new Set<ReturnType<typeof fakeSubscriptions>>()
/**
 * Read subscriptions of every fake server in this test file are answered by posting their action to `fetch`. Returns
 * `fetch` as the page's own: an action it posts over HTTP also answers the pages subscribed to that read, as the
 * server does.
 */
export function answerReadsWith(
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  answeringReads = fetch
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    const done = new Headers(init?.headers).has(ranByTheServer)
      ? []
      : [...servers]
          .map((server) => server.startAnswer(path, init))
          .filter((answer) => answer !== undefined)
    const response = await fetch(path, init)
    if (!done.length) return response
    const data = (await response
      .clone()
      .json()
      .catch(() => ({}))) as {
      result?: ReadSpec['args']
      error?: string
    }
    let superseded = false
    for (const { publish } of done) {
      const current = publish(
        response.ok
          ? { result: data.result ?? null }
          : { error: data.error ?? `${response.status}`, status: response.status },
      )
      if (!current) superseded = true
    }
    const { status, statusText, headers } = response
    return Response.json(
      { ...data, rev: done.at(-1)!.rev, ...(superseded ? { superseded: true } : {}) },
      { status, statusText, headers },
    )
  }
}

const ranByTheServer = 'x-fake-read'
class FakeActionError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * The server's side of `POST /api/events/<stream>` for a fake `fetch`: `handle` answers those requests and returns
 * undefined for any other, `refuse` makes it answer a conversation's subscriptions with a status. Read subscriptions
 * run through the server's own reads (server/reads.ts), each read posting its action to `actions` (the test's fetch).
 */
export function fakeSubscriptions(sources: FakeSource[], actions?: ActionFetch) {
  const subscriptions: FakeSubscription[] = []
  const reads: FakeRead[] = []
  const running = createReads(async ({ extension, action, args, conversation }) => {
    const answer = actions ?? answeringReads
    if (!answer) return await new Promise<never>(() => {})
    const response = await answer(
      `/api/extensions/${encodeURIComponent(extension)}/actions/${encodeURIComponent(action)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [ranByTheServer]: '1' },
        body: JSON.stringify({ args, conversationId: conversation }),
      },
    )
    const data = (await response.json().catch(() => ({}))) as { result?: unknown; error?: string }
    if (!response.ok) throw new FakeActionError(response.status, data.error ?? `${response.status}`)
    return data.result
  })
  const stops = new Map<string, () => void>()
  const deleted = new Set<string>()
  const refusals = new Map<number | undefined, number>()
  const server = {
    subscriptions,
    reads,
    /** Claims the action's revision before it runs so the HTTP response and its streamed answer share it. */
    startAnswer(path: string, init?: RequestInit) {
      const match = /^\/api\/extensions\/([^/]+)\/actions\/([^/]+)$/.exec(path)
      if (!match) return undefined
      const body = JSON.parse((init?.body as string) || '{}') as {
        args?: unknown
        conversationId?: number
      }
      return running.answering({
        extension: decodeURIComponent(match[1]),
        action: decodeURIComponent(match[2]),
        args: (body.args ?? null) as ReadSpec['args'],
        ...(body.conversationId === undefined ? {} : { conversation: body.conversationId }),
      })
    },
    /**
     * A conversation's subscriptions (undefined: the server's root) as one: `view` and `ops` go to its newest open view
     * subscription, `doc` and `docOps` to the open one watching that kind. With `view`, only the newest open view (true)
     * or document (false) subscription.
     */
    of(conversation?: number, view?: boolean): FakeSubscription | undefined {
      const open = subscriptions.filter(
        (item) =>
          !item.closed &&
          item.conversation === conversation &&
          (view === undefined || item.view === view),
      )
      const newest = open.at(-1)
      if (!newest || view !== undefined) return newest
      return {
        ...newest,
        get closed() {
          return open.every((item) => item.closed)
        },
        send: (name, data) => {
          const kind = (data as { kind?: string }).kind
          const target =
            kind === undefined
              ? open.findLast((item) => item.view)
              : open.findLast((item) => item.docs.includes(kind))
          if (!target)
            throw new Error(`No open subscription of ${conversation} carries ${kind ?? 'the view'}`)
          target.send(name, data)
        },
      }
    },
    refuse(conversation: number | undefined, status: number | undefined) {
      if (status === undefined) refusals.delete(conversation)
      else refusals.set(conversation, status)
    },
    handle(path: string, init?: RequestInit) {
      const match = /^\/api\/events\/([^/]+)$/.exec(path)
      if (!match) return undefined
      const [, stream] = match
      const batch = JSON.parse(init?.body as string) as {
        subscribe: (Pick<FakeSubscription, 'sub' | 'conversation' | 'docs' | 'view'> &
          Partial<Pick<FakeRead, 'read' | 'every'>>)[]
        unsubscribe: number[]
      }
      const failed: Record<number, number> = {}
      const source = sources.find((item) => item.id === stream && item.readyState === 1)
      if (!source) return Response.json({ error: 'Event stream ended' }, { status: 410 })
      const closing = new Set(batch.unsubscribe)
      for (const { sub, ...spec } of batch.subscribe) {
        if (closing.has(sub)) continue
        if (spec.read) {
          const read: FakeRead = {
            stream,
            sub,
            read: spec.read,
            every: spec.every,
            get closed() {
              return deleted.has(`${stream}/${sub}`) || source.closed || source.id !== stream
            },
          }
          reads.push(read)
          source.addEventListener('fake-close', () => stops.get(`${stream}/${sub}`)?.(), {
            once: true,
          })
          stops.set(
            `${stream}/${sub}`,
            running.subscribe(spec.read, spec.every, (event: ReadEvent) => {
              if (!read.closed && source.readyState === 1) source.send('read', event, sub)
            }),
          )
          continue
        }
        const status = refusals.get(spec.conversation)
        if (status) {
          failed[sub] = status
          continue
        }
        subscriptions.push({
          stream,
          sub,
          ...spec,
          get closed() {
            return deleted.has(`${stream}/${sub}`) || source.closed || source.id !== stream
          },
          send: (name, data) => source.send(name, data, sub),
        })
      }
      for (const { sub, stream: opened, closed } of [...subscriptions, ...reads])
        if (opened === stream && !closed && closing.has(sub)) {
          const key = `${stream}/${sub}`
          deleted.add(key)
          stops.get(key)?.()
          stops.delete(key)
        }
      return Response.json({ ok: true, refused: failed })
    },
  }
  servers.add(server)
  return server
}
