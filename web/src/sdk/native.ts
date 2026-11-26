type Port = {
  postMessage(message: string): void
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void
}
export type NativeCapability = 'push' | 'share' | 'theme'
export type NativeInfo = { version: number; app: string; capabilities: NativeCapability[] }
export type NativeShare = {
  title: string
  text: string
  url: string
  files: { name: string; type: string; path: string }[]
}

const port = (globalThis as { UltimateNative?: Port }).UltimateNative
const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
let next = 1

port?.addEventListener('message', ({ data }) => {
  const answer = JSON.parse(data) as { id: number; result?: unknown; error?: string }
  const pending = waiting.get(answer.id)
  if (!pending) return
  waiting.delete(answer.id)
  if (answer.error === undefined) pending.resolve(answer.result)
  else pending.reject(new Error(answer.error))
})

function call<T>(name: string, args?: object) {
  if (!port) return Promise.reject(new Error('No native app'))
  const id = next++
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve: (value) => resolve(value as T), reject })
    port.postMessage(JSON.stringify({ id, call: name, args }))
  })
}

let info: Promise<NativeInfo> | undefined

/** The native app showing this page in its WebView and what it can do, or undefined in a browser. */
export const nativeApp = () => (port ? (info ??= call<NativeInfo>('info')) : undefined)

/** Whether a native app shows this page and offers that capability. */
export async function nativeCan(capability: NativeCapability) {
  return (await nativeApp())?.capabilities.includes(capability) ?? false
}

/**
 * Calls into a native app that shows Ultimate in a WebView (an Android shell, say). The app injects
 * `window.UltimateNative`, a web message listener: the page posts `{ id, call, args }` as JSON and the app answers each
 * with `{ id, result }` or `{ id, error }`, only to a trusted origin's main frame. Each call belongs to a capability
 * the app lists in `info` (`{ version, app, capabilities }`); a page checks `nativeCan`, never the version, which
 * changes only when a call breaks.
 * - `push`: `pushSubscription` is this origin's Web Push subscription (`PushSubscription.toJSON()`'s shape) or null;
 *   `pushSubscribe` registers with the VAPID public key and resolves to it; `closeNotifications` closes this origin's
 *   notifications with those tags.
 * - `share`: `takeShare` is what was shared into the app, or null; each file is fetched from its same-origin `path`,
 *   which the app serves.
 * - `theme`: the app colours the system bars from `meta[name=theme-color]` itself.
 *
 * The app keeps the WebView clear of the system bars and the camera cutout, so the page needs no safe-area handling.
 */
export const native = {
  pushSubscription: () => call<PushSubscriptionJSON | null>('pushSubscription'),
  pushSubscribe: (key: string) => call<PushSubscriptionJSON>('pushSubscribe', { key }),
  pushUnsubscribe: () => call<null>('pushUnsubscribe'),
  closeNotifications: (tags: string[]) => call<null>('closeNotifications', { tags }),
  takeShare: () => call<NativeShare | null>('takeShare'),
}
