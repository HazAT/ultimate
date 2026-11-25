import { TriangleAlertIcon, XIcon } from '@lucide/solid'
import { createSignal, For, onSettled, Show, untrack } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  defineWebExtension,
  resumed,
  useConnection,
  useExtensions,
  useReady,
  useSystem,
} from '@/sdk/solid'

const readinessDeadlineMs = 8000

type Variant = 'boot' | 'cursor' | 'line'
const variants: readonly Variant[] = ['boot', 'cursor', 'line']
const variantKey = 'ultimate.splash-variant'
const held = new URLSearchParams(location.search).get('splash')
if (held && (variants as readonly string[]).includes(held)) localStorage.setItem(variantKey, held)
const variant = (): Variant => {
  const stored = localStorage.getItem(variantKey)
  return (variants as readonly string[]).includes(stored ?? '') ? (stored as Variant) : 'boot'
}

const stillMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

function Cursor(props: { class?: string }) {
  let cursor: HTMLSpanElement | undefined
  onSettled(() => {
    if (!cursor || stillMotion()) return undefined
    const blink = cursor.animate(
      [{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }],
      { duration: 1060, iterations: Infinity },
    )
    return () => blink.cancel()
  })
  return <span aria-hidden="true" class={props.class ?? 'bg-brand'} ref={cursor} />
}

function useBoot() {
  const connection = useConnection()
  const system = useSystem()
  const extensions = useExtensions()
  const ready = useReady()
  const loaded = () => extensions().filter((record) => !record.loading).length
  return {
    connected: () => connection().status === 'open',
    system,
    total: () => extensions().length,
    loaded,
    fraction: () => (extensions().length ? loaded() / extensions().length : 0),
    ready: () => ready().ready,
  }
}

function BootLog() {
  const boot = useBoot()
  const rows = () => [
    { label: 'stream', value: boot.connected() ? 'open' : 'connecting', done: boot.connected() },
    {
      label: 'host',
      value: boot.system()
        ? `${boot.system()!.machine.hostname} · gen ${boot.system()!.process.generation}`
        : '…',
      done: boot.system() !== undefined,
    },
    {
      label: 'ext',
      value: boot.total() ? `${boot.loaded()}/${boot.total()}` : '…',
      done: boot.total() > 0 && boot.loaded() === boot.total(),
    },
  ]
  return (
    <div class="w-full max-w-md font-mono text-[12px]">
      <div class="flex items-center text-[13px] font-semibold tracking-[0.3em] text-brand">
        ULTIMATE
        <Cursor class="ml-0.5 inline-block h-[1.05em] w-[0.6em] bg-brand" />
      </div>
      <div class="mt-5 grid grid-cols-[4rem_1fr] gap-x-3 gap-y-1 border-t border-border/70 pt-4 text-left">
        <For each={rows()}>
          {(row) => (
            <>
              <span class="text-muted-foreground/70">{row.label}</span>
              <span class={row.done ? 'text-foreground/85' : 'text-muted-foreground/60'}>
                {row.value}
              </span>
            </>
          )}
        </For>
      </div>
    </div>
  )
}

function WordmarkCursor() {
  const boot = useBoot()
  return (
    <div class="flex flex-col items-start font-mono">
      <div class="flex items-center text-[13px] font-semibold tracking-[0.3em] text-brand">
        ULTIMATE
        <Cursor class="ml-0.5 inline-block h-[1.05em] w-[0.6em] bg-brand" />
      </div>
      <div class="mt-2 h-px w-full overflow-hidden bg-border/60">
        <div
          class="h-full origin-left bg-brand/70 transition-transform duration-150 motion-reduce:transition-none"
          style={{ transform: `scaleX(${boot.fraction()})` }}
        />
      </div>
    </div>
  )
}

function BottomLine() {
  const boot = useBoot()
  const text = () =>
    !boot.connected()
      ? 'connecting'
      : !boot.system()
        ? 'reading system'
        : `gen ${boot.system()!.process.generation} · ext ${boot.loaded()}/${boot.total() || '…'}`
  return (
    <div class="fixed inset-x-0 bottom-0 flex h-7 items-center gap-2 border-t border-border/70 px-3 font-mono text-[10px] text-muted-foreground/70">
      <span class="font-semibold tracking-[0.3em] text-brand">ULTIMATE</span>
      <span>{text()}</span>
      <Cursor class="inline-block h-[1.1em] w-[0.55em] bg-muted-foreground/60" />
    </div>
  )
}

function Loading() {
  const shown = variant()
  return (
    <div
      class="pointer-events-none fixed inset-0 z-[60] grid place-items-center bg-background"
      data-splash=""
    >
      <progress aria-busy="true" aria-label="Loading Ultimate" aria-live="polite" class="sr-only" />
      <div
        aria-hidden="true"
        class="flex w-full justify-center animate-fade-in [animation-delay:200ms] motion-reduce:animate-none"
      >
        {shown === 'boot' ? <BootLog /> : shown === 'cursor' ? <WordmarkCursor /> : <BottomLine />}
      </div>
    </div>
  )
}

function Overlay() {
  const ready = useReady()
  const fresh = !untrack(() => ready().ready) && !resumed && !navigator.webdriver
  return (
    <Show
      when={(fresh || held !== null) && (held !== null || !ready().ready)}
      fallback={
        <Show when={ready().timedOut}>
          <Late />
        </Show>
      }
    >
      <Loading />
    </Show>
  )
}

function Names(props: { list: readonly string[] }) {
  return (
    <For each={props.list}>
      {(name, index) => (
        <span>
          {index() > 0 && ', '}
          <span class="text-foreground">{name}</span>
        </span>
      )}
    </For>
  )
}

function Late() {
  const ready = useReady()
  const [dismissed, setDismissed] = createSignal(false)
  return (
    <Show when={!dismissed() && (ready().pending.length || ready().failed.length)}>
      <div
        class="fixed top-12 left-1/2 z-40 flex w-96 max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-start gap-2 rounded-md border border-border/80 bg-popover px-2.5 py-2 font-mono text-[11.5px] leading-snug shadow-lg"
        role="alert"
      >
        <TriangleAlertIcon class="mt-px size-3.5 shrink-0 text-warning" />
        <div class="min-w-0 flex-1 text-foreground/90">
          <p>Not ready after {readinessDeadlineMs / 1000} s, so it opened anyway.</p>
          <p class="mt-0.5 text-muted-foreground">
            <Show when={ready().pending.length}>
              still loading: <Names list={ready().pending} />.{' '}
            </Show>
            <Show when={ready().failed.length}>
              failed: <Names list={ready().failed} />.{' '}
            </Show>
          </p>
        </div>
        <Button
          aria-label="Dismiss slow loading notice"
          size={null}
          variant={null}
          class="shrink-0 text-muted-foreground/60 hover:text-foreground"
          onClick={() => setDismissed(true)}
        >
          <XIcon class="size-3.5" />
        </Button>
      </div>
    </Show>
  )
}

export default defineWebExtension({ slots: { overlay: Overlay } })
