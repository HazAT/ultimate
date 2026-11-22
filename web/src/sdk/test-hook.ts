import { parseConversationId } from '../../../lib/ids.ts'
import type { ConversationId } from '@earendil-works/pi-durable'

import type { EventRecord } from '../../../shared/events.ts'
import { deadline, within } from '../../../lib/timers.ts'
import { CORE_EVENTS, EVENT_FEED } from '../../../shared/events.ts'
import type { Api } from './api.ts'
import { ROOT } from './api.ts'
import type { UiAgent, UiAgentHandle } from './agent.ts'
import type { UiState } from './ui-state.ts'
import type { State, Store } from './store.ts'

export type Condition =
  | 'idle'
  | 'quiet'
  | { entry: string }
  | { event: string; where?: Record<string, unknown> }
  | { ui: string; is?: Record<string, unknown> }
export interface UntilOptions {
  conversation?: number
  timeoutMs?: number
}

interface Sent {
  at: number
  entry: number
  event: number
  ran: boolean
}

const SENT_KEY = 'ultimate.sent'

type UiComponent = ReturnType<UiAgent['snapshot']>[number]
type ActResult = Awaited<ReturnType<UiAgent['act']>>

const isRef = (name: string) => /^c\d+$/.test(name)

const fold = (text: string) =>
  text.normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase()

export function createTestHook(
  store: Store,
  api: Api,
  agent: UiAgentHandle,
  uiState: Pick<UiState, 'flush'>,
  rendered: Promise<void>,
  readsSettled: (signal: AbortSignal) => Promise<void>,
) {
  const saved = JSON.parse(sessionStorage.getItem(SENT_KEY) ?? '{"sent":[]}') as {
    sent: [ConversationId, Sent][]
    last?: ConversationId
  }
  const sent = new Map<ConversationId, Sent>(saved.sent)
  let lastSent = saved.last === undefined ? undefined : sent.get(saved.last)
  const save = (last = saved.last) => {
    saved.last = last
    sessionStorage.setItem(SENT_KEY, JSON.stringify({ sent: [...sent], last }))
  }

  store.watchDocOf(ROOT, EVENT_FEED)
  const feed = (state: State) =>
    (state.docsOf[ROOT]?.[EVENT_FEED] as { events?: EventRecord[] } | null)?.events ?? []
  const shown = (state: State) => state.view?.conversation.id ?? state.requested ?? ROOT
  const summary = (state: State, id: ConversationId) =>
    state.conversations.find((item) => item.id === id)
  const lastEntry = (state: State, id: ConversationId) =>
    (id === state.view?.conversation.id ? state.view : state.viewsOf[id])?.entries.at(-1)?.id ?? 0

  store.subscribe(() => {
    const state = store.getState()
    for (const [id, record] of sent) {
      const item = summary(state, id)
      const newlyObservedBusyOrAnswerAfterSend =
        !record.ran && (item?.busy || (item?.answerAt ?? 0) >= record.at)
      if (newlyObservedBusyOrAnswerAfterSend) {
        record.ran = true
        save()
      }
    }
  })

  function whenStoreConditionHolds<T>(
    test: (state: State) => T | undefined,
    timeoutMs: number,
    describe: (state: State) => string,
  ) {
    return new Promise<T>((resolve, reject) => {
      const check = () => {
        const value = test(store.getState())
        if (value === undefined) return false
        stop()
        cancel()
        resolve(value)
        return true
      }
      const stop = store.subscribe(check)
      const cancel = deadline(timeoutMs, () => {
        stop()
        reject(new Error(`Timed out after ${timeoutMs / 1000}s: ${describe(store.getState())}`))
      })
      check()
    })
  }

  const controlsMounted = (timeoutMs = 30_000) => {
    const gaveUp = new AbortController()
    return within(
      timeoutMs,
      rendered.then(() => readsSettled(gaveUp.signal)),
      () => {
        const error = new Error(
          `Timed out after ${timeoutMs / 1000}s: the page never rendered its surface with the data its components read`,
        )
        gaveUp.abort(error)
        return error
      },
    )
  }

  const firstSnapshotReady = (timeoutMs = 30_000) =>
    whenStoreConditionHolds(
      (state) => (state.view && state.tasks ? true : undefined),
      timeoutMs,
      () => 'the page never received its first snapshot',
    )

  async function named(name: string): Promise<UiComponent | undefined> {
    const bridge = agent.bridge()
    if (isRef(name)) {
      const byRef = await bridge.query({ within: name })
      return Array.isArray(byRef) && byRef[0]?.ref === name && !byRef[0].offPage
        ? byRef[0]
        : undefined
    }
    const found = await bridge.query({ text: name })
    const exact = Array.isArray(found)
      ? found.filter((item) => !item.offPage && item.label && fold(item.label) === fold(name))
      : []
    return exact.length === 1 ? exact[0] : undefined
  }

  async function act({ steps }: Parameters<UiAgent['act']>[0]) {
    const bridge = agent.bridge()
    const done: ActResult['steps'] = []
    const appeared = new Set<string>()
    let values: ActResult['values'] = {}
    const touchedNames = new Map<string, string>()
    const touched = new Set<string>()
    let error: ActResult['error']
    for (const [index, step] of steps.entries()) {
      const found = await named(step.ref)
      if (!found && isRef(step.ref)) {
        error = { step: index, message: `No component ${step.ref} on the page.` }
        break
      }
      const one = await bridge.act({ steps: [{ ...step, ref: found?.ref ?? step.ref }] })
      done.push(...one.steps.map((item) => ({ ...item, step: index })))
      for (const item of one.appeared) appeared.add(item.ref)
      values = one.values
      for (const item of one.steps) touched.add(item.ref)
      for (const name of Object.keys(one.values))
        if (touched.has(name.split(' ')[0])) touchedNames.set(name.split(' ')[0], name)
      if (!one.ok) {
        error = one.error && { ...one.error, step: index }
        break
      }
    }
    const now = async (ref: string) => named(ref)
    const live = (await Promise.all([...appeared].map(now))).filter(
      (item): item is UiComponent => !!item,
    )
    const open = (await Promise.all([...touched].map(now))).filter(
      (item): item is UiComponent => item?.open === true,
    )
    if ('more' in values) values = await keepTouched(values, touchedNames)
    return {
      ok: !error,
      ...(error && { error }),
      steps: done,
      ...(open.length ? { open } : {}),
      appeared: live,
      values,
    }
  }

  async function keepTouched(values: ActResult['values'], touchedNames: Map<string, string>) {
    const { more, ...listed } = values
    const restored: [string, unknown][] = []
    for (const [ref, name] of touchedNames) {
      if (Object.keys(listed).some((key) => key.startsWith(`${ref} `))) continue
      const now = await named(ref)
      const key = now && ('checked' in now ? 'checked' : 'value' in now ? 'value' : undefined)
      if (now && key && now.open !== true) restored.push([name, now[key]])
    }
    const touchedRefs = new Set(touchedNames.keys())
    const untouched = Object.keys(listed).filter((name) => !touchedRefs.has(name.split(' ')[0]))
    const kept = restored.slice(0, untouched.length)
    for (const name of untouched.slice(untouched.length - kept.length)) delete listed[name]
    return { ...Object.fromEntries(kept), ...listed, more }
  }

  const same = (a: unknown, b: unknown): boolean => {
    if (Array.isArray(a) || Array.isArray(b))
      return (
        Array.isArray(a) &&
        Array.isArray(b) &&
        a.length === b.length &&
        a.every((item, index) => same(item, b[index]))
      )
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const keys = Object.keys(a)
      return (
        keys.length === Object.keys(b).length &&
        keys.every((key) => same((a as never)[key], (b as never)[key]))
      )
    }
    return Object.is(a, b)
  }

  function untilUi(name: string, is: Record<string, unknown>, timeoutMs: number) {
    return new Promise<UiComponent>((resolve, reject) => {
      let ready = false
      let stopped = false
      let last: UiComponent | undefined
      let checking = false
      let again = false
      let stopChanges = () => {}
      const observer = new MutationObserver(() => recheck())
      const cancel = deadline(timeoutMs, () => {
        stop()
        const seen = !ready
          ? 'the page never rendered its controls'
          : last
            ? `${name} is ${JSON.stringify(last)}`
            : `no component named ${name}`
        reject(new Error(`Timed out after ${timeoutMs / 1000}s: ${seen}`))
      })
      function stop() {
        stopped = true
        stopChanges()
        observer.disconnect()
        cancel()
      }
      const check = async () => {
        if (checking) {
          again = true
          return
        }
        checking = true
        do {
          again = false
          last = await named(name)
          if (
            !stopped &&
            last &&
            Object.entries(is).every(([key, value]) => same(last![key], value))
          ) {
            stop()
            resolve(last)
          }
        } while (again && !stopped)
        checking = false
      }
      function recheck() {
        if (stopped) return
        check().catch((error: unknown) => {
          stop()
          reject(error instanceof Error ? error : new Error(String(error)))
        })
      }
      controlsMounted(timeoutMs).then(
        () => {
          if (stopped) return
          ready = true
          stopChanges = agent.bridge().subscribe(recheck)
          observer.observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          })
          recheck()
        },
        (error: unknown) => {
          if (stopped) return
          stop()
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })
  }

  function busyLine(state: State, id: ConversationId) {
    const item = summary(state, id)
    const phases = Object.values(state.tasks?.tasks ?? {})
      .filter((task) => task.conversationId === id && !task.background && 'phase' in task.state)
      .map((task) => ('phase' in task.state ? task.state.phase : ''))
    return `#${id}${item?.title ? ` ${item.title}` : ''}${phases.length ? ` (${phases.join(', ')})` : ''}`
  }

  return {
    api,

    ui: {
      async snapshot() {
        await controlsMounted()
        return agent
          .bridge()
          .snapshot()
          .filter((component) => !component.offPage)
      },
      async query(input: Parameters<UiAgent['query']>[0]) {
        await controlsMounted()
        return agent.bridge().query(input)
      },
      async act(input: Parameters<UiAgent['act']>[0]) {
        await controlsMounted()
        return act(input)
      },
      ready: () => controlsMounted(),
      flush: () => uiState.flush(),
    },

    async state() {
      await firstSnapshotReady()
      const state = store.getState()
      return {
        shown: shown(state),
        conversations: state.conversations.map(({ id, title, busy }) => ({
          id,
          title,
          busy,
        })),
        entries: state.view?.entries.map((entry) => entry.kind) ?? [],
      }
    },

    async send(text: string, options: { conversation?: number } = {}) {
      await firstSnapshotReady()
      const state = store.getState()
      const id =
        options.conversation === undefined
          ? shown(state)
          : parseConversationId(options.conversation)
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

    async until(condition: Condition, options: UntilOptions = {}) {
      const timeoutMs = options.timeoutMs ?? 300_000
      if (typeof condition === 'object' && 'ui' in condition)
        return untilUi(condition.ui, condition.is ?? {}, timeoutMs)
      const started = Date.now()
      await firstSnapshotReady(timeoutMs)
      const left = () => Math.max(0, timeoutMs - (Date.now() - started))

      const id =
        options.conversation === undefined
          ? (saved.last ?? shown(store.getState()))
          : parseConversationId(options.conversation)
      if (id !== shown(store.getState()) && typeof condition === 'object' && 'entry' in condition)
        store.watchConversation(id)
      const record = options.conversation === undefined ? lastSent : sent.get(id)
      if (condition === 'idle')
        return whenStoreConditionHolds(
          (state) => {
            const observedBusyOrAnswerAfterSend = sent.get(id)?.ran ?? true
            return observedBusyOrAnswerAfterSend && !summary(state, id)?.busy
              ? { conversation: id }
              : undefined
          },
          left(),
          (state) =>
            sent.get(id)?.ran === false
              ? `#${id} has not started the sent turn`
              : `${busyLine(state, id)} is still busy`,
        )
      if (condition === 'quiet')
        return whenStoreConditionHolds(
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
        return whenStoreConditionHolds(
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

      const system = await whenStoreConditionHolds(
        (state) => state.system,
        left(),
        () => 'no system info',
      )
      const known = [...CORE_EVENTS, ...system.extensions.flatMap((extension) => extension.events)]
      if (!known.includes(condition.event)) {
        const near = known.filter((name) => name.split('.')[0] === condition.event.split('.')[0])
        throw new Error(
          `Unknown event ${condition.event}; ${near.length ? `did you mean ${near.join(', ')}?` : `known: ${known.join(', ')}`}`,
        )
      }
      const where = Object.entries(condition.where ?? {})
      const matches = (event: EventRecord) =>
        event.id > (record?.event ?? 0) &&
        where.every(
          ([key, value]) =>
            JSON.stringify((event.data as Record<string, unknown> | null)?.[key]) ===
            JSON.stringify(value),
        )
      const found = await whenStoreConditionHolds(
        (state) =>
          feed(state).find(
            (event) =>
              (event.name === condition.event || event.fails === condition.event) && matches(event),
          ),
        left(),
        (state) => {
          const names = feed(state)
            .filter((event) => event.id > (record?.event ?? 0))
            .map((event) => event.name)
          return `no matching ${condition.event} event; since: ${names.slice(-8).join(', ') || 'none'}`
        },
      )
      if (found.name !== condition.event)
        throw new Error(
          `${found.name} instead of ${condition.event}: ${JSON.stringify(found.data)}`,
        )
      return found
    },
  }
}
export type TestHook = ReturnType<typeof createTestHook>

declare global {
  interface Window {
    ultimate?: TestHook
  }
}
