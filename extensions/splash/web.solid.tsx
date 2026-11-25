import { TriangleAlertIcon, XIcon } from '@lucide/solid'
import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Input } from '@/components/ui/input.solid.tsx'
import {
  defineWebExtension,
  composerDraft,
  getState,
  fillComposer,
  resumed,
  uncoveredComposer,
  useConnection,
  useExtensions,
  useReady,
  useSystem,
} from '@/sdk/solid'
import { firstRender } from '@/sdk/resume.ts'

const readinessDeadlineMs = 8000
const typeInStartMs = 200
const typeInLetterMs = 45
const exitMs = 160
const wordmark = 'ULTIMATE'

function Typed(props: { text: string }) {
  let word: HTMLSpanElement | undefined
  onSettled(() => {
    if (!word || matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined
    const letters = props.text.length
    const typing = word.animate(
      [{ width: '0ch' }, { width: `calc(${letters}ch + ${letters} * 0.3em)` }],
      {
        delay: typeInStartMs,
        duration: letters * typeInLetterMs,
        easing: `steps(${letters}, end)`,
        fill: 'backwards',
      },
    )
    return () => typing.cancel()
  })
  return (
    <span class="inline-block overflow-hidden whitespace-nowrap" ref={word}>
      {props.text}
    </span>
  )
}
const held = new URLSearchParams(location.search).has('splash')
function handOver(text: string) {
  const conversation = getState().view?.conversation.id
  if (!text || conversation === undefined) return
  const draft = composerDraft(conversation).text
  const joined = draft ? `${draft}\n${text}` : text
  fillComposer(conversation, joined)
  const composer = uncoveredComposer()
  if (!(composer instanceof HTMLTextAreaElement)) return
  composer.focus()
  requestAnimationFrame(() => composer.setSelectionRange(joined.length, joined.length))
}

const isBrowserReload = (event: KeyboardEvent) =>
  event.key === 'F5' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r')

function keepKeysInside(overlay: HTMLElement) {
  const inside = (event: KeyboardEvent) => {
    if (isBrowserReload(event)) return
    event.stopImmediatePropagation()
    if (!(event.target instanceof Node && overlay.contains(event.target))) event.preventDefault()
  }
  const refocus = (event: FocusEvent) => {
    if (event.target instanceof Node && !overlay.contains(event.target))
      overlay.querySelector('input')?.focus({ preventScroll: true })
  }
  window.addEventListener('keydown', inside, true)
  window.addEventListener('keyup', inside, true)
  document.addEventListener('focusin', refocus, true)
  return () => {
    window.removeEventListener('keydown', inside, true)
    window.removeEventListener('keyup', inside, true)
    document.removeEventListener('focusin', refocus, true)
  }
}

function Cursor() {
  let cursor: HTMLSpanElement | undefined
  onSettled(() => {
    if (!cursor || matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined
    const blink = cursor.animate(
      [{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }],
      {
        delay: typeInStartMs + wordmark.length * typeInLetterMs,
        duration: 1060,
        iterations: Infinity,
      },
    )
    return () => blink.cancel()
  })
  return (
    <span
      aria-hidden="true"
      class="ml-0.5 inline-block h-[1.05em] w-[0.6em] bg-brand"
      ref={cursor}
    />
  )
}

function Prompt() {
  let box: HTMLDivElement | undefined
  onSettled(() => box?.querySelector('input')?.focus({ preventScroll: true }))
  return (
    <div
      class="mt-4 flex animate-fade-in items-center gap-2 text-left [animation-delay:500ms] motion-reduce:animate-none"
      ref={box}
    >
      <span aria-hidden="true" class="text-brand">
        ›
      </span>
      <Input
        aria-label="Start typing while Ultimate loads"
        class="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-[12px] caret-brand shadow-none focus-visible:ring-0 placeholder:text-muted-foreground/50"
        placeholder="start typing, it carries over"
      />
    </div>
  )
}

function Boot() {
  const connection = useConnection()
  const system = useSystem()
  const extensions = useExtensions()
  const loaded = () => extensions().filter((record) => !record.loading).length
  const rows = () => [
    {
      label: 'stream',
      value: connection().status === 'open' ? 'open' : 'connecting',
      done: connection().status === 'open',
    },
    {
      label: 'host',
      value: system() ? `${system()!.machine.hostname} · gen ${system()!.process.generation}` : '…',
      done: system() !== undefined,
    },
    {
      label: 'ext',
      value: extensions().length ? `${loaded()}/${extensions().length}` : '…',
      done: extensions().length > 0 && loaded() === extensions().length,
    },
  ]
  return (
    <div class="w-full max-w-md font-mono text-[12px]">
      <div
        aria-hidden="true"
        class="flex items-center text-[13px] font-semibold tracking-[0.3em] text-brand"
      >
        <Typed text={wordmark} />
        <Cursor />
      </div>
      <div
        aria-hidden="true"
        class="mt-5 grid animate-fade-in [animation-delay:200ms] motion-reduce:animate-none grid-cols-[4rem_1fr] gap-x-3 gap-y-1 border-t border-border/70 pt-4 text-left"
      >
        <For each={rows()}>
          {(row) => (
            <>
              <span class="text-muted-foreground/70">{row.label}</span>
              <span
                class={
                  row.done
                    ? 'text-foreground/85'
                    : 'animate-pulse-dot text-muted-foreground/60 motion-reduce:animate-none'
                }
              >
                {row.value}
              </span>
            </>
          )}
        </For>
      </div>
      <Prompt />
    </div>
  )
}

function Loading(props: { onDone: () => void }) {
  const ready = useReady()
  let overlay: HTMLDivElement | undefined
  const leaving = createMemo(() => !held && ready().ready)
  createEffect(leaving, (leave) => {
    if (!overlay) return undefined
    if (!leave) return keepKeysInside(overlay)
    const input = overlay.querySelector('input')
    if (input) input.readOnly = true
    const text = input?.value ?? ''
    void firstRender.then(() => handOver(text))
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      props.onDone()
      return undefined
    }
    const fade = overlay.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: exitMs,
      easing: 'ease-out',
      fill: 'both',
    })
    void fade.finished.then(props.onDone, props.onDone)
    return () => fade.cancel()
  })
  return (
    <div
      class="fixed inset-0 z-[60] grid place-items-center bg-background data-leaving:pointer-events-none"
      data-leaving={leaving() ? '' : undefined}
      data-splash=""
      ref={overlay}
    >
      <progress aria-busy="true" aria-label="Loading Ultimate" aria-live="polite" class="sr-only" />
      <div class="flex w-full justify-center">
        <Boot />
      </div>
    </div>
  )
}

function Overlay() {
  const ready = useReady()
  const [gone, setGone] = createSignal(
    !held && (untrack(() => ready().ready) || resumed || navigator.webdriver),
  )
  return (
    <Show
      when={!gone()}
      fallback={
        <Show when={ready().timedOut}>
          <Late />
        </Show>
      }
    >
      <Loading onDone={() => setGone(true)} />
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
