import type { JsonValue } from '@earendil-works/chord/json'
import { inProcess } from '../lib/errors.ts'
import { retryAfter } from '../lib/timers.ts'
import type { Cancel } from '../lib/timers.ts'
import type { ReadEvent, ReadSpec } from '../shared/protocol.ts'

type Send = (event: ReadEvent) => void
type Run = (spec: ReadSpec, signal: AbortSignal) => Promise<unknown>

interface Entry {
  spec: ReadSpec
  subscribers: Map<symbol, { every?: number; send: Send }>
  sent?: string
  answeredAt: number
  running?: AbortController
  again?: Cancel
  started: number
  shown: number
}

export const readKey = ({ extension, action, args, conversation }: ReadSpec) =>
  JSON.stringify([extension, action, args ?? null, conversation ?? null])

const failure = (error: unknown, status?: number): ReadEvent => ({
  error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
  status: status ?? (error as { status?: number } | undefined)?.status ?? 500,
})

export function createReads(run: Run, now = () => Date.now()) {
  const entries = new Map<string, Entry>()

  function publish(entry: Entry, startedAt: number, event: ReadEvent) {
    if (startedAt < entry.shown) return
    entry.shown = startedAt
    entry.answeredAt = now()
    const json = JSON.stringify(event)
    if (json !== entry.sent) {
      entry.sent = json
      for (const { send } of entry.subscribers.values()) send(event)
    }
    schedule(entry)
  }

  function schedule(entry: Entry) {
    entry.again?.()
    entry.again = undefined
    const every = Math.min(...[...entry.subscribers.values()].map((item) => item.every ?? Infinity))
    if (every === Infinity || entry.running) return
    const dueInMs = Math.max(0, entry.answeredAt + every - now())
    entry.again = retryAfter(dueInMs, () => runOnce(entry))
  }

  function runOnce(entry: Entry) {
    if (entry.running) return
    const controller = (entry.running = new AbortController())
    const startedAt = ++entry.started
    inProcess(
      'a read runs only for the pages subscribed to it, and they resubscribe to a new process, which runs it again',
      run(entry.spec, controller.signal)
        .then(
          (result) => ({ result: (result ?? null) as JsonValue }),
          (error: unknown) => {
            if (!controller.signal.aborted)
              console.error(`Read ${entry.spec.extension}/${entry.spec.action} failed`)
            return failure(error)
          },
        )
        .then((event) => {
          if (controller.signal.aborted) return
          entry.running = undefined
          if (startedAt < entry.shown) schedule(entry)
          else publish(entry, startedAt, event)
        }),
    )
  }

  return {
    subscribe(spec: ReadSpec, every: number | undefined, send: Send): Cancel {
      const key = readKey(spec)
      let entry = entries.get(key)
      if (!entry) {
        entry = { spec, subscribers: new Map(), answeredAt: 0, started: 0, shown: 0 }
        entries.set(key, entry)
      }
      const id = Symbol(key)
      const own = entry
      own.subscribers.set(id, { every, send })
      if (own.sent !== undefined) send(JSON.parse(own.sent) as ReadEvent)
      if (own.sent === undefined) runOnce(own)
      else schedule(own)
      return () => {
        if (!own.subscribers.delete(id)) return
        if (own.subscribers.size) return schedule(own)
        own.running?.abort()
        own.again?.()
        entries.delete(key)
      }
    },
    answering(spec: ReadSpec): Send {
      const entry = entries.get(readKey(spec))
      if (!entry) return () => {}
      const startedAt = ++entry.started
      return (event) => {
        if (entries.get(readKey(spec)) === entry) publish(entry, startedAt, event)
      }
    },
    refused: (status: number, message: string): ReadEvent => failure(message, status),
    size: () => entries.size,
  }
}
export type Reads = ReturnType<typeof createReads>
