/**
 * The only timers product code uses (`ultimate/no-raw-timer`). Each name says why time, not an event, decides when it
 * runs, and each returns its cancel, so an effect can return it as its cleanup. Browser-safe.
 */

export type Cancel = () => void

type Handle = ReturnType<typeof setTimeout>
const lenient = (handle: Handle, unref: boolean | undefined) => {
  if (unref) (handle as { unref?: () => void }).unref?.()
  return handle
}

/** Runs `fn` `ms` after the latest call: input that settles before it is acted on. */
export function debounce(ms: number, fn: () => void) {
  let handle: Handle | undefined
  const call = () => {
    clearTimeout(handle)
    handle = setTimeout(fire, ms)
  }
  const fire = () => {
    handle = undefined
    fn()
  }
  return Object.assign(call, {
    /** Runs a pending call now. */
    flush: () => {
      if (handle !== undefined) {
        clearTimeout(handle)
        fire()
      }
    },
    cancel: () => {
      clearTimeout(handle)
      handle = undefined
    },
  })
}

/** Runs `fn` once, `ms` after the first of a burst of calls: changes gathered into one write. */
export function batch(ms: number, fn: () => void, { unref }: { unref?: boolean } = {}) {
  let handle: Handle | undefined
  const call = () => {
    handle ??= lenient(
      setTimeout(() => {
        handle = undefined
        fn()
      }, ms),
      unref,
    )
  }
  return Object.assign(call, {
    cancel: () => {
      clearTimeout(handle)
      handle = undefined
    },
  })
}

/** Calls `expire` unless cancelled within `ms`: a real deadline on something that has no signal of its own. */
export function deadline(
  ms: number,
  expire: () => void,
  { unref }: { unref?: boolean } = {},
): Cancel {
  const handle = lenient(setTimeout(expire, Math.max(0, ms)), unref)
  return () => clearTimeout(handle)
}

/** `work`, or `error` once `ms` pass first: a deadline on a promise that may never settle. `signal` drops the deadline. */
export function within<T>(
  ms: number,
  work: Promise<T>,
  error: () => Error,
  signal?: AbortSignal,
): Promise<T> {
  let cancel: Cancel | undefined
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      cancel = deadline(ms, () => reject(error()))
      signal?.addEventListener('abort', () => cancel?.(), { once: true })
    }),
  ]).finally(() => cancel?.())
}

/** Calls `fn` again after `ms`: the next attempt after a failure. */
export const retryAfter = (ms: number, fn: () => void, options: { unref?: boolean } = {}): Cancel =>
  deadline(ms, fn, options)

/** Calls `fn` every `ms`: a real schedule, or a poll of something that publishes no change. */
export function every(ms: number, fn: () => void, { unref }: { unref?: boolean } = {}): Cancel {
  const handle = setInterval(fn, ms)
  if (unref) (handle as { unref?: () => void }).unref?.()
  return () => clearInterval(handle)
}

/** Resolves after `ms`, or rejects when `signal` aborts: the beats of a paced sequence (animation, audio, backoff). */
export function pace(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const cancel = deadline(ms, () => {
      signal?.removeEventListener('abort', aborted)
      resolve()
    })
    const aborted = () => {
      cancel()
      reject(signal!.reason)
    }
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

/** Runs `fn` in a later task, once the current one and the work it queued are done. */
export function nextTurn(fn: () => void): Cancel {
  return deadline(0, fn)
}
