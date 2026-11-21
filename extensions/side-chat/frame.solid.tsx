/** @jsxImportSource @solidjs/web */
import { ArrowLeft, GitFork } from '@lucide/solid'
import { cn } from 'cn'
import { createMemo, createRoot, createSignal, For, Show, useContext } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Kbd } from '@/components/ui/kbd.solid.tsx'
import {
  api,
  column,
  ComposerRedirect,
  formatTime,
  ROOT,
  useConversationId,
  useDocOf,
  useUiState,
  writerNow,
  writingAs,
} from '@/sdk/solid'
import type { ComposerTarget, SolidComposerProps } from '@/sdk/solid'
import { StandingDoc } from '../subagents/refs.ts'
import { FRONT_KEY } from './front.ts'
import { frontSide, openSides, togglesSideMode } from './logic.ts'
import { OpenAction, SideChatsDoc } from './refs.ts'

export const ease = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

const [sideMode, setSideMode] = createRoot(() => createSignal(false))

export function ComposerFrame(props: SolidComposerProps) {
  const id = useConversationId()
  const index = useDocOf(id, SideChatsDoc)
  const ultimate = useDocOf(() => ROOT, StandingDoc)
  const mainId = () => ultimate()?.ultimate
  const [front, setFront] = useUiState<number | null>(FRONT_KEY, null)
  const active = createMemo(() => id() !== undefined && id() === mainId() && !props.dock)
  const sides = createMemo(() => (props.dock ? [] : openSides(index() ?? undefined)))
  const covering = createMemo(() =>
    props.dock ? undefined : frontSide(front(), index() ?? undefined),
  )
  const parked = createMemo(() => sides().filter((item) => item.id !== covering()?.id))
  const on = () => sideMode() && active()
  const outer = useContext(ComposerRedirect)
  const target = createMemo((): ComposerTarget | undefined =>
    on()
      ? {
          placeholder: 'Ask on the side — @ultimate keeps running…',
          send: async (text) => {
            const who = writerNow()
            const opened = await api.action(OpenAction, { text }, { conversationId: mainId() })
            writingAs(who, () => {
              setSideMode(false)
              setFront(opened.id)
            })
          },
        }
      : outer(),
  )
  const onKeyDown = (event: KeyboardEvent) => {
    if (!active() || !(event.target instanceof HTMLTextAreaElement)) return
    const popup = event.target.getAttribute('aria-expanded') === 'true'
    if (!togglesSideMode(event, { conversation: id(), ultimate: mainId(), popup })) return
    event.preventDefault()
    setSideMode(!on())
  }
  return (
    <div
      class="relative"
      data-side-mode={active() ? (on() ? 'side' : 'normal') : undefined}
      ref={(element) => element.addEventListener('keydown', onKeyDown, { capture: true })}
    >
      <div data-main-composer={active() || undefined} inert={!!covering()}>
        <div
          class={cn(column(), 'flex items-center justify-between gap-2 pb-1.5')}
          hidden={!active() && !(sides().length && parked().length)}
        >
          <div
            class="flex min-w-0 items-center gap-3 font-mono text-[11px] text-muted-foreground/70"
            data-ui="side-chat-hint"
          >
            <For each={parked()} keyed={(item) => item.id}>
              {(item) => (
                <Button
                  aria-label={`Show ${item().question === undefined ? 'side chat' : 'question side chat'} #${item().id}`}
                  class="h-auto shrink-0 gap-1.5 rounded-sm p-0 font-mono text-[11px] font-normal text-muted-foreground hover:text-foreground"
                  onClick={() => setFront(item().id)}
                  size={null}
                  title="Bring this side chat back to the front"
                  variant={null}
                >
                  <GitFork class="size-3 text-brand" />
                  {item().question === undefined ? 'Side chat' : 'Question side chat'} ·{' '}
                  {formatTime(item().openedAt)}
                  <span class="text-brand">show</span>
                </Button>
              )}
            </For>
            <Show when={active() && parked().length === 0}>
              <span class="truncate pointer-coarse:hidden">
                <Show
                  when={on()}
                  fallback={
                    <>
                      <Kbd>Tab</Kbd> side chat
                    </>
                  }
                >
                  <span class="text-brand">↵</span> forks @ultimate · <Kbd>Tab</Kbd> back to normal
                </Show>
              </span>
            </Show>
          </div>
          <Show when={active()}>
            <ModeSwitch on={on()} onToggle={() => setSideMode(!on())} />
          </Show>
        </div>
        <div
          class={cn(
            'relative transition-[padding] duration-300 motion-reduce:transition-none',
            on() ? 'sm:pl-6' : 'pl-0',
            '[&_form]:transition-[border-color] [&_form]:duration-300',
            on() &&
              '[&_form]:border-dashed [&_form]:border-brand/60 [&_form]:focus-within:border-brand/80',
          )}
          style={{ 'transition-timing-function': ease }}
        >
          <ComposerRedirect value={target}>{props.core}</ComposerRedirect>
        </div>
      </div>
      <Show when={covering()}>
        <MainBlocked onBack={() => setFront(null)} />
      </Show>
    </div>
  )
}

function ModeSwitch(props: { on: boolean; onToggle: () => void }) {
  return (
    <Button
      aria-label={`Composer sends to ${props.on ? 'a new side chat' : '@ultimate'} · Tab switches`}
      aria-pressed={props.on ? 'true' : 'false'}
      class="relative h-5 gap-0 rounded-full bg-muted/60 p-0.5 font-mono text-[10.5px] font-normal"
      data-ui="side-chat-switch"
      onClick={() => props.onToggle()}
      size={null}
      variant={null}
    >
      <span
        aria-hidden="true"
        class={cn(
          'absolute top-0.5 bottom-0.5 left-0.5 w-[4.75rem] rounded-full bg-background shadow-xs transition-transform duration-300 motion-reduce:transition-none',
          props.on && 'translate-x-[4.75rem] ring-1 ring-brand/40',
        )}
        style={{ 'transition-timing-function': ease }}
      />
      <span
        class={cn(
          'relative z-10 w-[4.75rem] text-center whitespace-nowrap transition-colors',
          props.on ? 'text-muted-foreground/70' : 'text-foreground',
        )}
      >
        Normal
      </span>
      <span
        class={cn(
          'relative z-10 flex w-[4.75rem] items-center justify-center gap-1 whitespace-nowrap transition-colors',
          props.on ? 'text-brand' : 'text-muted-foreground/70',
        )}
      >
        <GitFork class="size-2.5" />
        Side chat
      </span>
    </Button>
  )
}

function MainBlocked(props: { onBack: () => void }) {
  return (
    <div class="absolute inset-0 z-10 flex items-center bg-background/70 backdrop-blur-[1px]">
      <div class={column()}>
        <div class="flex w-fit items-center gap-3 rounded-lg border border-border bg-card px-3.5 py-2 font-mono text-[11.5px] text-muted-foreground shadow-sm">
          <GitFork class="size-3.5 text-brand" />
          <span>Typing goes to the side chat</span>
          <Button
            class="h-auto gap-1 rounded-sm px-1.5 py-0.5 font-mono text-[11.5px] font-normal text-foreground hover:bg-accent"
            onClick={() => props.onBack()}
            size={null}
            variant={null}
          >
            <ArrowLeft class="size-3" />
            Back to main
          </Button>
        </div>
      </div>
    </div>
  )
}
