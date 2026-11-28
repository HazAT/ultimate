import { GitFork } from '@lucide/solid'
import { cn } from 'cn'
import { createMemo, Show, useContext } from 'solid-js'
import { Toggle } from '@/components/ui/toggle.solid.tsx'
import { Kbd } from '@/components/ui/kbd.solid.tsx'
import {
  column,
  ComposerRedirect,
  ROOT,
  useConversationId,
  useDocOf,
  useUiState,
  writerNow,
  writingAs,
} from '@/sdk/solid'
import type { ComposerTarget, SolidComposerProps } from '@/sdk/solid'
import { StandingDoc } from '../subagents/refs.ts'
import { dock, sendTyped, setSideChatSource, sideChatSink } from './dock.solid.tsx'
import { openSideChat, SheetComposer } from './panel.solid.tsx'
import { SOURCE_KEY, useForkable } from './side.solid.tsx'
import { sourceName, togglesSideMode } from './side.web.ts'

export const ease = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

export function SideComposer(props: SolidComposerProps) {
  return <SheetComposer {...props} core={<ComposerFrame {...props} />} />
}

function ComposerFrame(props: SolidComposerProps) {
  const id = useConversationId()
  const ultimate = useDocOf(() => ROOT, StandingDoc)
  const [, setSource] = useUiState<number | null>(SOURCE_KEY, null)
  const mainId = () => ultimate()?.ultimate
  const name = () => sourceName(mainId() ?? 0, ultimate(), undefined)
  const forkable = useForkable(mainId)
  const active = createMemo(
    () => id() !== undefined && id() === mainId() && !props.dock && forkable() === true,
  )
  const on = () => dock.sideMode() && active()
  const outer = useContext(ComposerRedirect)
  const target = createMemo((): ComposerTarget | undefined =>
    on()
      ? {
          placeholder: `Ask on the side — ${name()} keeps running…`,
          images: true,
          ...(dock.conversation() ? { dictation: sideChatSink } : {}),
          send: async (text, images) => {
            const who = writerNow()
            const sent = sendTyped(text, images)
            writingAs(who, () => {
              dock.setSideMode(false)
              openSideChat()
            })
            await sent
          },
        }
      : outer(),
  )
  const toggle = () => {
    const next = !on()
    if (next) {
      setSource(null)
      setSideChatSource(mainId())
    }
    dock.setSideMode(next)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (!active() || !(event.target instanceof HTMLTextAreaElement)) return
    const popup = event.target.getAttribute('aria-expanded') === 'true'
    if (!togglesSideMode(event, { conversation: id(), ultimate: mainId(), popup })) return
    event.preventDefault()
    toggle()
  }
  return (
    <div
      class="relative"
      data-side-mode={active() ? (on() ? 'side' : 'normal') : undefined}
      ref={(element) => element.addEventListener('keydown', onKeyDown, { capture: true })}
    >
      <Show when={active()}>
        <div class={cn(column(), 'flex items-center justify-between gap-2 pb-1.5')}>
          <span
            class="min-w-0 truncate font-mono text-[11px] text-muted-foreground/70 pointer-coarse:hidden"
            data-ui="side-chat-hint"
          >
            <Show
              when={on()}
              fallback={
                <>
                  <Kbd>Tab</Kbd> side chat
                </>
              }
            >
              <span class="text-brand">↵</span> forks {name()} · <Kbd>Tab</Kbd> back to normal
            </Show>
          </span>
          <ModeSwitch name={name()} on={on()} onToggle={toggle} />
        </div>
      </Show>
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
  )
}

function ModeSwitch(props: { name: string; on: boolean; onToggle: () => void }) {
  return (
    <Toggle
      aria-label={`Composer sends to ${props.on ? 'a new side chat' : props.name} · Tab switches`}
      pressed={props.on}
      class="group/side-mode relative h-5 gap-0 rounded-full bg-muted/60 p-0.5 font-mono text-[10.5px] font-normal data-pressed:bg-muted/60 data-pressed:text-inherit"
      data-ui="side-chat-switch"
      onPressedChange={() => props.onToggle()}
      size={null}
      variant={null}
    >
      <span
        aria-hidden="true"
        class={cn(
          'absolute top-0.5 bottom-0.5 left-0.5 w-[4.75rem] rounded-full bg-background shadow-xs transition-transform duration-300 motion-reduce:transition-none',
          'group-data-pressed/side-mode:translate-x-[4.75rem] group-data-pressed/side-mode:ring-1 group-data-pressed/side-mode:ring-brand/40',
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
    </Toggle>
  )
}
