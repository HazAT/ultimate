/**
 * Concurrency caps on model requests: at most `limits.global` streams at once overall and `limits.models[provider/id]`
 * per model (`modelFamilies.limits`, lib/families.ts), for a local model that serves only a few sessions at a time.
 * A request over a cap waits, first come first served, before its stream opens; an abort while waiting ends it
 * aborted. Unset or zero is unlimited, the usual case. The caps are read when the harness opens and again in the
 * background as each request starts, so a request never waits on the settings file and a change applies a request
 * later.
 */
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { Api, AssistantMessage, Model, Models } from '@earendil-works/pi-ai'
import type { Limits } from '../lib/families.ts'

type Waiter = { key: string; start: () => void }

/** In-flight and waiting requests, by `provider/id`, under the caps `limits` reads. */
export function createModelGate(limits: () => Promise<Limits>) {
  const running = new Map<string, number>()
  let total = 0
  let current: Limits = { models: {} }
  let reading: Promise<void> | undefined
  const refresh = () => {
    return (reading ??= limits()
      .then((next) => {
        current = next
        // Raised caps let waiting requests start.
        drain()
      })
      .catch((error: unknown) => {
        // A broken settings file keeps the caps read last; the families dialog shows the problem.
        console.error('model caps not read:', error)
      })
      .finally(() => {
        reading = undefined
      }))
  }
  const queue: Waiter[] = []
  const fits = (key: string) =>
    (!current.global || total < current.global) &&
    (!current.models[key] || (running.get(key) ?? 0) < current.models[key])
  const take = (key: string) => {
    total++
    running.set(key, (running.get(key) ?? 0) + 1)
  }
  /** Start every waiter that fits now, in order; one held back by its model's cap does not hold back other models. */
  const drain = () => {
    for (let index = 0; index < queue.length;) {
      const waiter = queue[index]
      if (!fits(waiter.key)) {
        index++
        continue
      }
      queue.splice(index, 1)
      take(waiter.key)
      waiter.start()
    }
  }
  const release = (key: string) => {
    total--
    const left = (running.get(key) ?? 1) - 1
    if (left) running.set(key, left)
    else running.delete(key)
    drain()
  }
  /**
   * Take a slot for `key` now when one is free and nobody waits; the caps are read again in the background. A request
   * that gets one opens at once, in the same tick, as it would without caps.
   */
  function tryAcquire(key: string) {
    // oxlint-disable-next-line typescript/no-floating-promises -- refresh catches its own failure.
    void refresh()
    if (queue.length || !fits(key)) return false
    take(key)
    return true
  }
  /** Wait in line for a slot for `key`, holding it until `release`; rejects when `signal` aborts first. */
  function wait(key: string, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        key,
        start: () => {
          signal?.removeEventListener('abort', abort)
          resolve()
        },
      }
      const abort = () => {
        const index = queue.indexOf(waiter)
        if (index !== -1) queue.splice(index, 1)
        reject(signal!.reason)
      }
      if (signal?.aborted) return abort()
      signal?.addEventListener('abort', abort, { once: true })
      queue.push(waiter)
      drain()
    })
  }
  return {
    tryAcquire,
    wait,
    release,
    /** Read the caps now, as when the harness opens; resolves once they apply. */
    refresh,
    /** Running and waiting requests, by `provider/id`. */
    usage: () => ({
      total,
      running: Object.fromEntries(running),
      waiting: Object.fromEntries(
        Map.groupBy(queue, (waiter) => waiter.key)
          .entries()
          .map(([key, items]) => [key, items.length]),
      ),
    }),
  }
}
export type ModelGate = ReturnType<typeof createModelGate>

/** A response that ended before any provider answered it. */
function ended(
  model: Pick<Model<Api>, 'api' | 'provider' | 'id'>,
  stopReason: 'error' | 'aborted',
  errorMessage: string,
): AssistantMessage {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  }
}

/** `models` whose streams wait for `gate` before they open, and hold their slot until they settle. */
export function limitModels<T extends Models>(models: T, gate: ModelGate): T {
  const streamSimple: Models['streamSimple'] = (model, context, options) => {
    const key = `${model.provider}/${model.id}`
    if (gate.tryAcquire(key)) {
      const source = models.streamSimple(model, context, options)
      // The slot frees once the response settles, however it ends.
      const free = () => gate.release(key)
      source.result().then(free, free)
      return source
    }
    const out = createAssistantMessageEventStream()
    void (async () => {
      try {
        await gate.wait(key, options?.signal)
      } catch {
        // Aborted while waiting: the request never reached the provider, so it ends aborted with nothing used.
        const error = ended(model, 'aborted', 'Aborted while waiting for a free model slot')
        out.push({ type: 'error', reason: 'aborted', error })
        return out.end()
      }
      try {
        const source = models.streamSimple(model, context, options)
        for await (const event of source) {
          out.push(event)
          if (event.type === 'done' || event.type === 'error') return out.end()
        }
        // A source may also settle by its result alone, without a terminal event.
        out.end(await source.result())
      } finally {
        gate.release(key)
      }
    })().catch((error: unknown) => {
      const message = ended(model, 'error', `Model stream failed: ${String(error)}`)
      out.push({ type: 'error', reason: 'error', error: message })
      out.end()
    })
    return out
  }
  // The target's own completeSimple calls its streamSimple on itself, past this proxy: route it through ours.
  const completeSimple: Models['completeSimple'] = (model, context, options) =>
    streamSimple(model, context, options).result()
  return new Proxy(models, {
    get(target, key) {
      if (key === 'streamSimple') return streamSimple
      if (key === 'completeSimple') return completeSimple
      const value: unknown = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
