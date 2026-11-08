/**
 * Push notifications in the browser: the actions the status line's bell uses to subscribe this browser to the
 * project's pushes, test them and report while the app is on screen. Browser-safe.
 */
import { actionRef } from '../../shared/extension-api.ts'

/** A browser's push subscription, as `PushSubscription.toJSON()` gives it, with the page origin it subscribed from. */
export type Subscription = {
  endpoint: string
  keys: { p256dh: string; auth: string }
  /** `https://host:port`: what a tap opens and the VAPID subject; each origin is its own installed app. */
  origin: string
}

/** `null` → `{ key }`: the VAPID public key to subscribe with (base64url), made on first call. User-only. */
export const KeyAction = actionRef<null, { key: string }>('push', 'key')
/** `{ subscription }` → `null`: push to this browser from now on; sent again on every load. User-only. */
export const SubscribeAction = actionRef<{ subscription: Subscription }, null>('push', 'subscribe')
/** `{ endpoint }` → `null`: stop pushing to that browser. User-only. */
export const UnsubscribeAction = actionRef<{ endpoint: string }, null>('push', 'unsubscribe')
/** `{ endpoint }` → `{ status }`: push a test now; `status` is the push service's HTTP status. User-only. */
export const TestAction = actionRef<{ endpoint: string }, { status: number }>('push', 'test')
/**
 * `{ endpoint, visible }` → `null`: that browser shows the app (sent every 10 s while shown) or hid it. A browser
 * seen on screen in the last 15 s gets no push. User-only.
 */
export const PresentAction = actionRef<{ endpoint: string; visible: boolean }, null>(
  'push',
  'present',
)
