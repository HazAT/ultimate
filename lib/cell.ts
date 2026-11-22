export function cell<T>(value: T, { notifyOnEqual = false } = {}) {
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next: T) => {
      if (!notifyOnEqual && Object.is(value, next)) return
      value = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
