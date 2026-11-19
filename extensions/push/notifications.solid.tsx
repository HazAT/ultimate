/** @jsxImportSource @solidjs/web */
import { Bell as BellIcon, BellOff, Send } from '@lucide/solid'
import { createEffect, createMemo, createRoot, createSignal, onSettled, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Popover, PopoverContent } from '@/components/ui/popover.solid.tsx'
import { StatusPopoverTrigger } from '@/components/ui/status-trigger.solid.tsx'
import { Switch } from '@/components/ui/switch.solid.tsx'
import {
  api,
  cn,
  errorMessage,
  events,
  ROOT,
  showSurface,
  switchConversation,
  useDocOf,
  writingAs,
} from '@/sdk/solid'
import { parseConversationId } from '../../lib/ids.ts'
import { isOpen } from '../../lib/message-state.ts'
import { every } from '../../lib/timers.ts'
import { MessagesDoc } from '../messages/refs.ts'
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
const [here, setHere] = createRoot(() => createSignal<Here>({}))
const update = (change: Partial<Here>) => setHere((previous) => ({ ...previous, ...change }))
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
  'ServiceWorkerRegistration' in window &&
  'pushManager' in ServiceWorkerRegistration.prototype &&
  'getNotifications' in ServiceWorkerRegistration.prototype

let launched = false
function launch() {
  if (launched) return
  launched = true
  navigator.serviceWorker
    .register('/sw.js')
    .then(async (registration) => {
      update({ registration })
      const subscription = await registration.pushManager.getSubscription()
      if (!subscription || Notification.permission !== 'granted') return
      update({ subscription })
      await writingAs('app', () =>
        api.action(SubscribeAction, { subscription: json(subscription) }),
      )
    })
    .catch(failed)
}

const VISIBLE_PAGE_HEARTBEAT_MS = 10_000

export function Pusher() {
  const log = useDocOf(() => ROOT, MessagesDoc)
  const closed = useDocOf(() => ROOT, ClosedDoc)
  const settledTags = createMemo(() =>
    [
      ...(log()?.messages ?? [])
        .filter((m) => m.to === 'user' && m.reply && !isOpen(m))
        .map((m) => `message:${m.id}`),
      ...(closed()?.tags ?? []),
    ].join('\n'),
  )
  const subscribedEndpoint = createMemo(() => here().subscription?.endpoint)
  const workerRegistration = createMemo(() => here().registration)

  createEffect(subscribedEndpoint, (endpoint) => {
    if (!endpoint) return undefined
    const report = (visible: boolean) => {
      writingAs('app', () =>
        api.action(PresentAction, { endpoint, visible }, { keepalive: !visible }),
      ).catch((error: unknown) => console.warn('Push presence', error))
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
  })
  createEffect(
    () => ({ settled: settledTags(), registration: workerRegistration() }),
    (state) => {
      const { settled, registration } = state
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
    },
  )
  onSettled(() => {
    if (!hasPushSupport) return undefined
    launch()
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
  })
  return null
}

function blocked() {
  if (!hasPushSupport)
    return "This browser can't receive push notifications; install Ultimate as an app first."
  if (Notification.permission === 'denied')
    return 'Notifications are blocked for this app; allow them in its settings.'
  return undefined
}

async function toggle(on: boolean, source: string) {
  const { registration, subscription } = here()
  update({ error: undefined })
  if (on && registration) {
    const { key } = await api.action(KeyAction, null)
    const next = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: bytes(key),
    })
    await writingAs(source, () => api.action(SubscribeAction, { subscription: json(next) }))
    update({ subscription: next })
  } else if (!on && subscription) {
    await subscription.unsubscribe()
    update({ subscription: undefined })
    await writingAs(source, () =>
      api.action(UnsubscribeAction, { endpoint: subscription.endpoint }),
    )
  }
}

const row = 'flex h-8 items-center justify-between gap-2 px-2 text-[12px]'

export function Bell() {
  const [test, setTest] = createSignal<string>()
  const on = () => here().subscription !== undefined
  const message = () => blocked() ?? here().error
  const sendTest = async () => {
    const subscription = here().subscription
    if (!subscription) return
    setTest('Sending…')
    try {
      const { status } = await api.action(TestAction, { endpoint: subscription.endpoint })
      setTest(status >= 200 && status < 300 ? 'Sent' : String(status))
    } catch (error) {
      setTest('Failed')
      failed(error)
    }
  }
  return (
    <Popover onOpenChange={() => setTest(undefined)}>
      <StatusPopoverTrigger
        aria-label="Notifications"
        class={cn(!on() && 'text-muted-foreground/60')}
      >
        {on() ? <BellIcon class="size-3" /> : <BellOff class="size-3" />}
        notify
      </StatusPopoverTrigger>
      <PopoverContent align="end" class="w-72 p-1 font-mono" side="top">
        <label class={row}>
          Notifications on this device
          <Switch
            checked={on()}
            disabled={!on() && (!here().registration || blocked() !== undefined)}
            onCheckedChange={(next, details) => void toggle(next, details.source).catch(failed)}
          />
        </label>
        <Show when={message()}>
          <output class="block px-2 pb-1 text-[11px] leading-4 text-muted-foreground">
            {message()}
          </output>
        </Show>
        <Show when={on()}>
          <Button
            aria-label="Send test"
            class={cn(
              row,
              'w-full rounded-sm border-t border-border/70 py-0 font-normal hover:bg-accent hover:text-current dark:hover:bg-accent',
            )}
            onClick={sendTest}
            variant="ghost"
          >
            <span class="flex items-center gap-2">
              <Send class="size-3" />
              Send test
            </span>
            <Show when={test()}>
              <span
                class={cn(
                  'text-[11px] text-muted-foreground',
                  test() !== 'Sent' && test() !== 'Sending…' && 'text-error',
                )}
              >
                {test()}
              </span>
            </Show>
          </Button>
        </Show>
        <div class="border-t border-border/70 px-2 pt-1.5 pb-1 text-[11px] leading-4 text-muted-foreground">
          Questions waiting on you, with Approve and Reply; landings; @ultimate's failed runs. None
          while this device shows Ultimate.
        </div>
      </PopoverContent>
    </Popover>
  )
}
