import { BellIcon, BellOffIcon, SendIcon } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { api, cn, defineWebExtension, errorMessage, events, useDocOf, useUltimate } from '@/sdk'
import { isOpen, MessagesDoc } from '../messages/ui.tsx'
import {
  ClosedDoc,
  KeyAction,
  PresentAction,
  SubscribeAction,
  TestAction,
  UnsubscribeAction,
} from './refs.ts'
import type { Subscription } from './refs.ts'

/** This browser's service worker and push subscription, once known; `error` says why the last step failed. */
type Here = {
  registration?: ServiceWorkerRegistration
  subscription?: PushSubscription
  error?: string
}
let here: Here = {}
const listeners = new Set<() => void>()
const update = (change: Partial<Here>) => {
  here = { ...here, ...change }
  for (const listener of listeners) listener()
}
const useHere = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    () => here,
  )
const failed = (error: unknown) => update({ error: errorMessage(error) })

const json = (subscription: PushSubscription): Subscription => ({
  ...(subscription.toJSON() as Omit<Subscription, 'origin'>),
  origin: location.origin,
})
/** A base64url key as the bytes `pushManager.subscribe` takes. */
const bytes = (key: string) =>
  Uint8Array.from(atob(key.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))

/**
 * Whether this browser can show pushes. Every path goes through it: without it the extension does nothing. An Android
 * WebView (react-native-webview 13.16.1, 2026-11-11) has service workers but no Notifications or Push API, and once
 * threw "getNotifications is not a function" on every page.
 */
const supported =
  'serviceWorker' in navigator &&
  'Notification' in window &&
  'pushManager' in ServiceWorkerRegistration.prototype &&
  'getNotifications' in ServiceWorkerRegistration.prototype

let launched = false
/**
 * The service worker (registering it again is a no-op beside the share extension's); a subscribed browser sends its
 * subscription again, in case the server lost it.
 */
function launch() {
  if (launched || !supported) return
  launched = true
  navigator.serviceWorker
    .register('/sw.js')
    .then(async (registration) => {
      update({ registration })
      const subscription = await registration.pushManager.getSubscription()
      if (!subscription || Notification.permission !== 'granted') return
      update({ subscription })
      await api.action(SubscribeAction, { subscription: json(subscription) })
    })
    .catch(failed)
}

/** How often a shown page says so; the server skips a browser seen in the last 15 s. */
const presentMs = 10_000

/**
 * Renders nothing: registers the service worker, reports while a subscribed page is on screen, closes the
 * notifications of questions answered elsewhere and opens what a tapped notification names.
 */
function Pusher() {
  const { registration, subscription } = useHere()
  const { showSurface, switchConversation } = useUltimate()
  useEffect(() => launch(), [])
  const endpoint = subscription?.endpoint
  useEffect(() => {
    if (!endpoint) return undefined
    const report = (visible: boolean) => {
      api
        .action(PresentAction, { endpoint, visible }, { keepalive: !visible })
        // A missed report costs one push too many or too few; the next one corrects it.
        .catch((error: unknown) => console.warn('Push presence', error))
    }
    const tick = () => {
      if (document.visibilityState === 'visible') report(true)
    }
    const changed = () => report(document.visibilityState === 'visible')
    const hide = () => report(false)
    tick()
    const timer = setInterval(tick, presentMs)
    document.addEventListener('visibilitychange', changed)
    window.addEventListener('pagehide', hide)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', changed)
      window.removeEventListener('pagehide', hide)
    }
  }, [endpoint])
  // A question answered on its card or another device takes its notification with it, as does a tag another
  // extension closed (`PushApi.close`).
  const log = useDocOf(1, MessagesDoc)
  const closed = useDocOf(1, ClosedDoc)?.tags ?? []
  const settled = [
    ...(log?.messages ?? [])
      .filter((m) => m.to === 'user' && m.reply && !isOpen(m))
      .map((m) => `message:${m.id}`),
    ...closed,
  ].join('\n')
  useEffect(() => {
    if (!settled || !registration) return
    const tags = new Set(settled.split('\n'))
    registration
      .getNotifications()
      .then((shown) => {
        for (const notification of shown) if (tags.has(notification.tag)) notification.close()
      })
      .catch((error: unknown) => console.warn('Closing answered notifications', error))
  }, [settled, registration])
  useEffect(() => {
    if (!supported) return undefined
    const opened = (event: MessageEvent<{ type?: string; url?: string }>) => {
      if (event.data?.type !== 'ultimate:open' || !event.data.url) return
      const url = new URL(event.data.url, location.href)
      // A question or another Inbox item opens the Inbox at it, where it is answered.
      const key = url.searchParams.get('inbox')
      if (key) {
        events.emit('inbox:open', { key })
        showSurface('inbox')
        return
      }
      const id = Number(url.searchParams.get('conversation'))
      if (!Number.isSafeInteger(id) || id <= 0) return
      const message = Number(url.searchParams.get('message'))
      if (url.searchParams.has('message') && Number.isSafeInteger(message))
        events.emit('messages:open', { conversation: id, message })
      showSurface('agent')
      switchConversation(id)
    }
    navigator.serviceWorker.addEventListener('message', opened)
    return () => navigator.serviceWorker.removeEventListener('message', opened)
  }, [showSurface, switchConversation])
  return null
}

/** Why this browser cannot get pushes, or nothing. */
function blocked() {
  if (!supported)
    return "This browser can't receive push notifications; install Ultimate as an app first."
  if (Notification.permission === 'denied')
    return 'Notifications are blocked for this app; allow them in its settings.'
  return undefined
}

async function turnOn(registration: ServiceWorkerRegistration) {
  const { key } = await api.action(KeyAction, null)
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: bytes(key),
  })
  await api.action(SubscribeAction, { subscription: json(subscription) })
  update({ subscription })
}

async function turnOff(subscription: PushSubscription) {
  await subscription.unsubscribe()
  update({ subscription: undefined })
  await api.action(UnsubscribeAction, { endpoint: subscription.endpoint })
}

const row = 'flex h-8 items-center justify-between gap-2 px-2 text-[12px]'

/** The status line's bell: notifications on this device, a test push, and why they cannot be on. */
function Bell() {
  const { registration, subscription, error } = useHere()
  const [test, setTest] = useState<string>()
  const on = subscription !== undefined
  const reason = blocked()
  const toggle = (next: boolean) => {
    update({ error: undefined })
    if (next && registration) turnOn(registration).catch(failed)
    else if (!next && subscription) turnOff(subscription).catch(failed)
  }
  const sendTest = () => {
    if (!subscription) return
    setTest('Sending…')
    api
      .action(TestAction, { endpoint: subscription.endpoint })
      .then(({ status }) => setTest(status >= 200 && status < 300 ? 'Sent' : String(status)))
      .catch((caught: unknown) => {
        setTest('Failed')
        failed(caught)
      })
  }
  return (
    <Popover onOpenChange={() => setTest(undefined)}>
      <PopoverTrigger asChild>
        <button
          aria-label="Notifications"
          className={cn(
            '-mx-1 flex items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground',
            !on && 'text-muted-foreground/60',
          )}
          type="button"
        >
          {on ? <BellIcon className="size-3" /> : <BellOffIcon className="size-3" />}
          notify
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1 font-mono" side="top">
        <label className={cn(row, 'cursor-pointer')}>
          Notifications on this device
          <Switch
            checked={on}
            disabled={!on && (reason !== undefined || !registration)}
            onCheckedChange={toggle}
          />
        </label>
        {(reason ?? error) && (
          <div className="px-2 pb-1 text-[11px] leading-4 text-muted-foreground" role="status">
            {reason ?? error}
          </div>
        )}
        {on && (
          <button
            className={cn(
              row,
              'w-full cursor-pointer rounded-sm border-t border-border/70 hover:bg-accent',
            )}
            onClick={sendTest}
            type="button"
          >
            <span className="flex items-center gap-2">
              <SendIcon className="size-3" />
              Send test
            </span>
            {test && (
              <span
                className={cn(
                  'text-[11px] text-muted-foreground',
                  test !== 'Sent' && test !== 'Sending…' && 'text-error',
                )}
              >
                {test}
              </span>
            )}
          </button>
        )}
        <div className="border-t border-border/70 px-2 pt-1.5 pb-1 text-[11px] leading-4 text-muted-foreground">
          Questions waiting on you, with Approve and Reply; landings; @ultimate's failed runs. None
          while this device shows Ultimate.
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default defineWebExtension({
  slots: { overlay: [Pusher], 'statusline.right': [{ component: Bell, order: -1 }] },
})
