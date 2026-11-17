import { parseConversationId } from '../../lib/ids.ts'
import { ROOT } from '@/sdk'
import { every } from '../../lib/timers.ts'
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
const bytes = (key: string) =>
  Uint8Array.from(atob(key.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))

const hasPushSupport =
  'serviceWorker' in navigator &&
  'Notification' in window &&
  'pushManager' in ServiceWorkerRegistration.prototype &&
  'getNotifications' in ServiceWorkerRegistration.prototype

let launched = false
function launch() {
  if (launched || !hasPushSupport) return
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

const VISIBLE_PAGE_HEARTBEAT_MS = 10_000

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
        .catch((error: unknown) => console.warn('Push presence', error))
    }
    const tick = () => {
      if (document.visibilityState === 'visible') report(true)
    }
    const changed = () => report(document.visibilityState === 'visible')
    const hide = () => report(false)
    tick()
    const stopReporting = every(VISIBLE_PAGE_HEARTBEAT_MS, tick)
    document.addEventListener('visibilitychange', changed)
    window.addEventListener('pagehide', hide)
    return () => {
      stopReporting()
      document.removeEventListener('visibilitychange', changed)
      window.removeEventListener('pagehide', hide)
    }
  }, [endpoint])
  const log = useDocOf(ROOT, MessagesDoc)
  const closed = useDocOf(ROOT, ClosedDoc)?.tags ?? []
  const settled = [
    ...(log?.messages ?? [])
      .filter((m) => m.to === 'user' && m.reply && !isOpen(m))
      .map((m) => `message:${m.id}`),
    ...closed,
  ].join('\n')
  useEffect(() => {
    if (!settled || !registration) return undefined
    const tags = new Set(settled.split('\n'))
    let scanIsCurrent = true
    const scan = () => {
      registration
        .getNotifications()
        .then((shown) => {
          if (!scanIsCurrent) return
          for (const notification of shown) if (tags.has(notification.tag)) notification.close()
        })
        .catch((error: unknown) => console.warn('Closing answered notifications', error))
    }
    const rescanShownPush = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type === 'ultimate:shown') scan()
    }
    scan()
    navigator.serviceWorker.addEventListener('message', rescanShownPush)
    return () => {
      scanIsCurrent = false
      navigator.serviceWorker.removeEventListener('message', rescanShownPush)
    }
  }, [settled, registration])
  useEffect(() => {
    if (!hasPushSupport) return undefined
    const opened = (event: MessageEvent<{ type?: string; url?: string }>) => {
      if (event.data?.type !== 'ultimate:open' || !event.data.url) return
      const url = new URL(event.data.url, location.href)
      const key = url.searchParams.get('inbox')
      if (key) {
        events.emit('inbox:open', { key })
        showSurface('inbox')
        return
      }
      const id = parseConversationId(Number(url.searchParams.get('conversation')))
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

function blocked() {
  if (!hasPushSupport)
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
