import { createRoot, createSignal, onSettled } from 'solid-js'

export function useExternal<T>(get: () => T, subscribe: (notify: () => void) => () => void) {
  const [value, setValue] = createSignal<T>(get)
  onSettled(() => {
    const update = () => setValue(() => get())
    const unsubscribe = subscribe(update)
    update()
    return unsubscribe
  })
  return value
}

const visible = createRoot(() =>
  useExternal(
    () => document.visibilityState === 'visible',
    (changed) => {
      document.addEventListener('visibilitychange', changed)
      return () => document.removeEventListener('visibilitychange', changed)
    },
  ),
)

export const usePageVisible = () => visible

export function useConversationWidth(overlay: () => HTMLElement) {
  const [width, setWidth] = createSignal(0)
  onSettled(() => {
    const parent = overlay().closest<HTMLElement>('[data-ui="conversation"]')
    if (!parent) return undefined
    const measure = () => setWidth(parent.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    return () => observer.disconnect()
  })
  return width
}
