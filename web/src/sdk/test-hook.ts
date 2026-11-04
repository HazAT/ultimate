// `window.ultimate` on pages the browser tool drives: send input, set up state through the page's SDK `api` and wait on
// Ultimate's state instead of on time.
import type { EventRecord } from '../../../shared/events.ts'
import { EVENT_FEED } from '../../../shared/events.ts'
import type { Api } from './api.ts'
import { ROOT } from './api.ts'
import type { State, Store } from './store.ts'

/** What `until` waits for: the conversation's turn done, nothing busy anywhere, a new entry kind, or a durable event. */
export type Condition =
  | 'idle'
  | 'quiet'
  | { entry: string }
  | { event: string; where?: Record<string, unknown> }
export interface UntilOptions {
  /** Defaults to the last sent-to conversation, else the shown one. */
  conversation?: number
  timeoutMs?: number
}

/** What a page knew when it sent: a turn counts only once it was seen running or answered after the send. */
interface Sent {
  at: number
  entry: number
  event: number
  ran: boolean
}

/** Where a page keeps its sent records, so a reload mid-wait (new web bundle, server swap) still waits for the sent turn. */
const SENT_KEY = 'ultimate.sent'

export function createTestHook(store: Store, api: Api) {
  const saved = JSON.parse(sessionStorage.getItem(SENT_KEY) ?? '{"sent":[]}') as {
    sent: [number, Sent][]
    last?: number
  }
  const sent = new Map<number, Sent>(saved.sent)
  let lastSent = saved.last === undefined ? undefined : sent.get(saved.last)
  const save = (last = saved.last) => {
    saved.last = last
    sessionStorage.setItem(SENT_KEY, JSON.stringify({ sent: [...sent], last }))
  }
  // The root's event feed is what `{event}` reads; watched for the page's lifetime.
  store.watchDocOf(ROOT, EVENT_FEED)
  const feed = (state: State) =>
    (state.docsOf[ROOT]?.[EVENT_FEED] as { events?: EventRecord[] } | null)?.events ?? []
  const shown = (state: State) => state.view?.conversation.id ?? state.requested ?? ROOT
  const summary = (state: State, id: number) => state.conversations.find((item) => item.id === id)
  const lastEntry = (state: State, id: number) =>
    (id === state.view?.conversation.id ? state.view : state.viewsOf[id])?.entries.at(-1)?.id ?? 0
  // A turn shorter than the server's busy refresh never shows busy; its answer timestamp still proves it ran.
  store.subscribe(() => {
    const state = store.getState()
    for (const [id, record] of sent) {
      const item = summary(state, id)
      if (!record.ran && (item?.busy || (item?.answerAt ?? 0) >= record.at)) {
        record.ran = true
        save()
      }
    }
  })

  /** Resolves with the state once `test` holds for it, on the store change that makes it hold. */
  function when<T>(
    test: (state: State) => T | undefined,
    timeoutMs: number,
    describe: (state: State) => string,
  ) {
    return new Promise<T>((resolve, reject) => {
      const check = () => {
        const value = test(store.getState())
        if (value === undefined) return false
        stop()
        clearTimeout(timer)
        resolve(value)
        return true
      }
      const stop = store.subscribe(check)
      const timer = setTimeout(() => {
        stop()
        reject(new Error(`Timed out after ${timeoutMs / 1000}s: ${describe(store.getState())}`))
      }, timeoutMs)
      check()
    })
  }
  // The stream's first snapshot: the shown conversation, the list and the task graph.
  const ready = (timeoutMs = 30_000) =>
    when(
      (state) => (state.view && state.tasks ? true : undefined),
      timeoutMs,
      () => 'the page never received its first snapshot',
    )

  function busyLine(state: State, id: number) {
    const item = summary(state, id)
    const phases = Object.values(state.tasks?.tasks ?? {})
      .filter((task) => task.conversationId === id && !task.background && 'phase' in task.state)
      .map((task) => ('phase' in task.state ? task.state.phase : ''))
    return `#${id}${item?.title ? ` ${item.title}` : ''}${phases.length ? ` (${phases.join(', ')})` : ''}`
  }

  return {
    /**
     * The page's SDK client, for setting up state without clicking through the UI: `api.configure({model}, id)`,
     * `api.abort(id)`, `api.compact(undefined, id)`, `api.action({extension: 'pause', name: 'play'}, null)`.
     */
    api,
    /** The shown conversation, every conversation's busy flag and the shown view's entry kinds. */
    async state() {
      await ready()
      const state = store.getState()
      return {
        shown: shown(state),
        conversations: state.conversations.map(({ id, title, busy }) => ({ id, title, busy })),
        entries: state.view?.entries.map((entry) => entry.kind) ?? [],
      }
    },
    /** Submit `text` as the user would, to the shown conversation unless `conversation` is given. */
    async send(text: string, options: { conversation?: number } = {}) {
      await ready()
      const state = store.getState()
      const id = options.conversation ?? shown(state)
      if (id !== shown(state)) store.watchConversation(id)
      const record: Sent = {
        at: Date.now(),
        entry: lastEntry(state, id),
        event: feed(state).at(-1)?.id ?? 0,
        ran: false,
      }
      sent.set(id, record)
      lastSent = record
      save(id)
      const { submissionId } = await api.submit(text, undefined, id)
      return { conversation: id, submissionId }
    },
    /**
     * Wait until `condition` holds. After a `send` to the conversation, `idle` waits for that turn and `{entry}` and
     * `{event}` match only what came after it; without one they hold for what is already there.
     */
    async until(condition: Condition, options: UntilOptions = {}) {
      const timeoutMs = options.timeoutMs ?? 300_000
      const started = Date.now()
      await ready(timeoutMs)
      const left = () => Math.max(0, timeoutMs - (Date.now() - started))
      // The last send's conversation: a reloaded page may show another one.
      const id = options.conversation ?? saved.last ?? shown(store.getState())
      if (id !== shown(store.getState()) && typeof condition === 'object' && 'entry' in condition)
        store.watchConversation(id)
      const record = options.conversation === undefined ? lastSent : sent.get(id)
      if (condition === 'idle')
        return when(
          (state) => {
            const ran = sent.get(id)?.ran ?? true
            return ran && !summary(state, id)?.busy ? { conversation: id } : undefined
          },
          left(),
          (state) =>
            sent.get(id)?.ran === false
              ? `#${id} has not started the sent turn`
              : `${busyLine(state, id)} is still busy`,
        )
      if (condition === 'quiet')
        return when(
          (state) =>
            (record?.ran ?? true) && state.conversations.every((item) => !item.busy)
              ? { conversation: id }
              : undefined,
          left(),
          (state) =>
            record?.ran === false
              ? 'the sent turn has not started'
              : `still busy: ${state.conversations
                  .filter((item) => item.busy)
                  .map((item) => busyLine(state, item.id))
                  .join('; ')}`,
        )
      if ('entry' in condition)
        return when(
          (state) => {
            const view = id === state.view?.conversation.id ? state.view : state.viewsOf[id]
            const entry = view?.entries.find(
              (item) => item.kind === condition.entry && item.id > (sent.get(id)?.entry ?? 0),
            )
            return entry && { id: entry.id, kind: entry.kind }
          },
          left(),
          (state) => {
            const view = id === state.view?.conversation.id ? state.view : state.viewsOf[id]
            const kinds = view?.entries.slice(-5).map((entry) => entry.kind) ?? []
            return `no ${condition.entry} entry in #${id}; last entries: ${kinds.join(', ') || 'none'}`
          },
        )
      const where = Object.entries(condition.where ?? {})
      return when(
        (state) =>
          feed(state).find(
            (event) =>
              event.name === condition.event &&
              event.id > (record?.event ?? 0) &&
              where.every(
                ([key, value]) =>
                  JSON.stringify((event.data as Record<string, unknown> | null)?.[key]) ===
                  JSON.stringify(value),
              ),
          ),
        left(),
        (state) => {
          const names = feed(state)
            .filter((event) => event.id > (record?.event ?? 0))
            .map((event) => event.name)
          return `no matching ${condition.event} event; since: ${names.slice(-8).join(', ') || 'none'}`
        },
      )
    },
  }
}
export type TestHook = ReturnType<typeof createTestHook>
