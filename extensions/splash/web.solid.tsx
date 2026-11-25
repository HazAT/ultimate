import { TriangleAlertIcon, XIcon } from '@lucide/solid'
import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  onSettled,
  Show,
  untrack,
} from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Input } from '@/components/ui/input.solid.tsx'
import {
  defineWebExtension,
  composerDraft,
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
const wordmark = ['U', 'L', 'T', 'I', 'M', 'A', 'T', 'E']
const held = new URLSearchParams(location.search).has('splash')
const [typed, setTyped] = createRoot(() => createSignal(''))

function handOver() {
  const text = typed()
  const composer = uncoveredComposer()
  if (!text || !(composer instanceof HTMLTextAreaElement)) return
  const conversation = Number(composer.dataset.conversation)
  if (!Number.isInteger(conversation)) return
  const draft = composerDraft(conversation).text
  const joined = draft ? `${draft}\n${text}` : text
  fillComposer(conversation, joined)
  composer.focus()
  requestAnimationFrame(() => composer.setSelectionRange(joined.length, joined.length))
}

function Cursor() {
  let cursor: HTMLSpanElement | undefined
  onSettled(() => {
    if (!cursor || matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined
    const blink = cursor.animate(
      [{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }],
      { duration: 1060, iterations: Infinity },
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
        onValueChange={setTyped}
        placeholder="start typing, it carries over"
        value={typed()}
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
        <For each={wordmark}>
          {(letter, index) => (
            <span
              class="animate-type-in motion-reduce:animate-none"
              style={{ 'animation-delay': `${typeInStartMs + index() * typeInLetterMs}ms` }}
            >
              {letter}
            </span>
          )}
        </For>
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
    if (!leave || !overlay) return undefined
    void firstRender.then(handOver)
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
