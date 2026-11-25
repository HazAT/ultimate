export type Cancel = () => void

type Handle = ReturnType<typeof setTimeout>
const allowProcessExitWhenUnref = (handle: Handle, unref: boolean | undefined) => {
  if (unref) (handle as { unref?: () => void }).unref?.()
  return handle
}

export function debounce(quietPeriodMs: number, fn: () => void) {
  let handle: Handle | undefined
  const call = () => {
    clearTimeout(handle)
    handle = setTimeout(fire, quietPeriodMs)
  }
  const fire = () => {
    handle = undefined
    fn()
  }
  return Object.assign(call, {
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

export function batch(batchWindowMs: number, fn: () => void, { unref }: { unref?: boolean } = {}) {
  let handle: Handle | undefined
  const call = () => {
    handle ??= allowProcessExitWhenUnref(
      setTimeout(() => {
        handle = undefined
        fn()
      }, batchWindowMs),
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

export function deadline(
  deadlineMs: number,
  expire: () => void,
  { unref }: { unref?: boolean } = {},
): Cancel {
  const handle = allowProcessExitWhenUnref(setTimeout(expire, Math.max(0, deadlineMs)), unref)
  return () => clearTimeout(handle)
}

export function within<T>(
  timeoutMs: number,
  work: Promise<T>,
  error: () => Error,
  signal?: AbortSignal,
): Promise<T> {
  let cancel: Cancel | undefined
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      cancel = deadline(timeoutMs, () => reject(error()))
      signal?.addEventListener('abort', () => cancel?.(), { once: true })
    }),
  ]).finally(() => cancel?.())
}

export const retryAfter = (
  retryDelayMs: number,
  fn: () => void,
  options: { unref?: boolean } = {},
): Cancel => deadline(retryDelayMs, fn, options)

export function every(
  intervalMs: number,
  fn: () => void,
  { unref }: { unref?: boolean } = {},
): Cancel {
  const handle = setInterval(fn, intervalMs)
  if (unref) (handle as { unref?: () => void }).unref?.()
  return () => clearInterval(handle)
}

export function pace(beatMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const cancel = deadline(beatMs, () => {
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

export function nextTurn(fn: () => void): Cancel {
  return deadline(0, fn)
}

export function animationFrames(fn: () => void): Cancel {
  let handle = requestAnimationFrame(function tick() {
    fn()
    handle = requestAnimationFrame(tick)
  })
  return () => cancelAnimationFrame(handle)
}
