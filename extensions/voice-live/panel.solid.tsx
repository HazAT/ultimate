import {
  ArrowUp,
  AudioLines,
  ChevronLeft,
  ChevronRight,
  Mic,
  Pause,
  Play,
  Settings2,
  SkipBack,
  SkipForward,
  SquareArrowOutUpRight,
  X,
} from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onSettled,
  Show,
  Switch,
} from 'solid-js'
import { Shimmer } from '@/components/ai/shimmer.solid.tsx'
import { ToolImage } from '@/components/ai/tool.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import { Form } from '@/components/ui/form.solid.tsx'
import { Textarea } from '@/components/ui/input.solid.tsx'
import { Kbd } from '@/components/ui/kbd.solid.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control.solid.tsx'
import { Slider } from '@/components/ui/slider.solid.tsx'
import { Switch as Toggle } from '@/components/ui/switch.solid.tsx'
import {
  api,
  cn,
  formatKeys,
  ROOT,
  ScopedConversation,
  switchConversation,
  useAction,
  useDocOf,
  useExtensionUiState,
  useExternal,
  useViewport,
} from '@/sdk/solid'
import { every } from '../../lib/timers.ts'
import { ModelSelect } from '../models/ui.solid.tsx'
import {
  attach,
  dock,
  endSession,
  KEYS,
  press,
  release,
  sendTyped,
  setVoiceOpen,
  voiceOpen,
} from './dock.solid.tsx'
import { ModelAction, StatusAction, VoiceForkDoc, VoiceSessionDoc } from './refs.ts'
import { estimate } from './speech.ts'
import { Session, Waveform } from './turns.solid.tsx'

const variants = ['a', 'b', 'c'] as const
type Variant = (typeof variants)[number]

const toolbarButton =
  'flex h-7 max-w-56 min-w-0 shrink items-center gap-1.5 rounded-md px-2 font-mono text-[11.5px] font-normal text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-open:bg-accent data-open:text-foreground'
const iconButton =
  'flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-open:bg-accent data-open:text-foreground pointer-coarse:size-9'
const rowButton =
  'h-auto rounded p-0.5 font-normal text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-3'
const keys = () => formatKeys(KEYS)[0].join('+')

const recording = () => dock.phase() === 'recording'
const working = () => dock.phase() === 'sending' || dock.phase() === 'thinking'

export function VoiceModel(props: { class?: string }) {
  const status = useAction(StatusAction, null, { conversation: ROOT })
  return (
    <ModelSelect
      class={props.class}
      compact
      name="Voice model"
      onChange={(model) => {
        if (!model) return undefined
        return api.action(ModelAction, { model }).then(() => status.refetch())
      }}
      value={status.data()?.model}
    />
  )
}

function Status(props: { class?: string }) {
  const text = () => dock.error() ?? dock.status()
  return (
    <output
      class={cn(
        'flex min-w-0 items-center gap-1.5 truncate font-mono text-[11px] text-muted-foreground',
        (dock.error() || dock.phase() === 'error') && 'text-error',
        recording() && 'text-error',
        dock.phase() === 'speaking' && 'text-brand',
        props.class,
      )}
      data-voice-phase={dock.phase()}
    >
      <Show when={recording()}>
        <span class="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-error" />
      </Show>
      <Show when={working() && !dock.error()} fallback={<span class="truncate">{text()}</span>}>
        <Shimmer>{text()}</Shimmer>
      </Show>
    </output>
  )
}

function holdHandlers() {
  return {
    onPointerDown: (event: PointerEvent) => {
      event.preventDefault()
      void press()
    },
    onPointerLeave: () => void release(),
    onPointerUp: () => void release(),
  }
}

const holdTitle = () => `Hold to talk · or hold Space outside a text field · ${keys()} hides Voice`

function MicButton() {
  return (
    <Button
      aria-label="Hold to talk"
      class={cn(
        iconButton,
        'touch-none select-none',
        recording() && 'bg-error/15 text-error hover:bg-error/15 hover:text-error',
        dock.phase() === 'speaking' && 'text-brand',
      )}
      size={null}
      title={holdTitle()}
      variant={null}
      {...holdHandlers()}
    >
      <Mic class="size-4" />
    </Button>
  )
}

function HoldPill() {
  return (
    <Button
      aria-label="Hold to talk"
      class={cn(
        'flex h-7 shrink-0 touch-none items-center gap-1.5 rounded-full border border-border/80 bg-background px-2.5 font-mono text-[11.5px] font-normal text-muted-foreground transition-colors select-none hover:border-ring/70 hover:text-foreground',
        recording() &&
          'border-error/50 bg-error/10 text-error hover:border-error/50 hover:text-error',
        dock.phase() === 'speaking' && 'border-brand/40 text-brand',
      )}
      size={null}
      title={holdTitle()}
      variant={null}
      {...holdHandlers()}
    >
      <Mic class="size-3.5" />
      {recording() ? 'release' : dock.phase() === 'speaking' ? 'interrupt' : 'hold'}
    </Button>
  )
}

function TalkBar() {
  return (
    <Button
      aria-label="Hold to talk"
      class={cn(
        'relative flex h-9 w-full touch-none items-center gap-2.5 overflow-hidden rounded-lg border border-border/70 bg-muted/30 px-3 font-normal text-muted-foreground transition-colors select-none hover:border-ring/50 hover:bg-muted/50',
        recording() && 'border-error/40 bg-error/5 hover:border-error/40 hover:bg-error/5',
        dock.phase() === 'speaking' && 'border-brand/30',
      )}
      size={null}
      title={holdTitle()}
      variant={null}
      {...holdHandlers()}
    >
      <Mic class={cn('size-3.5 shrink-0', recording() && 'text-error')} />
      <Show when={recording()} fallback={<Status class="flex-1" />}>
        <Status class="shrink-0" />
        <Waveform class="h-5 min-w-0 flex-1 text-error" live />
      </Show>
      <span class="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground/70 pointer-coarse:hidden">
        hold <Kbd>Space</Kbd>
      </span>
    </Button>
  )
}

function Settings(props: { model?: boolean }) {
  return (
    <Popover>
      <PopoverTrigger aria-label="Voice settings" class={iconButton} title="Voice settings">
        <Settings2 class="size-4" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Voice settings options"
        class="w-64 p-0 font-mono text-[11.5px]"
        side="top"
      >
        <div class="px-3 pt-2.5 pb-1 section-label">Voice</div>
        <Show when={props.model}>
          <div class="px-1.5 pb-1">
            <VoiceModel class={cn(toolbarButton, 'w-full max-w-none')} />
          </div>
        </Show>
        <div class="flex flex-col gap-2.5 border-t border-border/60 px-3 py-2.5 text-muted-foreground">
          <label class="flex items-center justify-between gap-3">
            Speak replies
            <Toggle aria-label="Speak replies" bind={[dock.speak, dock.setSpeak]} />
          </label>
          <label class="flex items-center justify-between gap-3">
            Sound cues
            <Toggle aria-label="Voice sound cues" bind={[dock.cuesOn, dock.setCuesOn]} />
          </label>
          <label class="flex items-center justify-between gap-3">
            Speed
            <span class="flex items-center gap-2">
              <Slider
                aria-label="Speech speed"
                bind={[dock.rate, dock.setRate]}
                class="w-24"
                max={2}
                min={0.8}
                step={0.05}
              />
              <span class="w-9 text-right text-foreground/85 tabular-nums">
                {dock.rate().toFixed(2)}×
              </span>
            </span>
          </label>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Pasted() {
  return (
    <Show when={dock.pasted().length}>
      <div class="flex flex-wrap gap-2 px-3 pt-3">
        <For each={dock.pasted()}>
          {(item, index) => (
            <div class="relative w-32 rounded-md border border-border/80 bg-terminal p-1">
              <Show
                when={item.kind === 'image' ? item : undefined}
                fallback={
                  <p class="line-clamp-4 h-16 overflow-hidden px-1 font-mono text-[11px] text-muted-foreground">
                    {item.kind === 'text' ? item.text : ''}
                  </p>
                }
              >
                {(image) => (
                  <ToolImage
                    alt={`Pasted image ${index() + 1}`}
                    class="flex h-16 w-full items-center justify-center border-0 [&_img]:max-h-16"
                    image={image()}
                  />
                )}
              </Show>
              <Button
                aria-label={`Remove attachment ${index() + 1}`}
                class="absolute -top-2 -right-2 size-5 rounded-full border bg-background p-0 text-foreground hover:bg-accent"
                onClick={() => {
                  const removed = index()
                  dock.setPasted((items) => items.filter((_, at) => at !== removed))
                }}
                size={null}
                variant={null}
              >
                <X class="size-3" />
              </Button>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

function PromptBox(props: {
  inline?: boolean
  start?: JSX.Element
  tools?: JSX.Element
  end?: JSX.Element
  waveform?: boolean
}) {
  const [draft, setDraft] = createSignal('')
  const files = (list: FileList | undefined | null) => Array.from(list ?? [])
  const field = () => (
    <Textarea
      aria-label="Type or paste to voice"
      autoResize
      class={cn(
        'block max-h-40 min-h-0 w-full resize-none rounded-none border-0 bg-transparent font-sans text-[14px] leading-relaxed outline-none focus-visible:border-0 focus-visible:ring-0',
        props.inline ? 'px-1 py-1' : 'px-3.5 pt-3 pb-1',
      )}
      onDrop={(event: DragEvent) => {
        const dropped = files(event.dataTransfer?.files)
        if (!dropped.length) return
        event.preventDefault()
        void attach(dropped)
      }}
      onPaste={(event: ClipboardEvent) => {
        const pasted = files(event.clipboardData?.files)
        if (!pasted.length) return
        event.preventDefault()
        void attach(pasted)
      }}
      onValueChange={setDraft}
      placeholder={
        props.inline
          ? dock.phase() === 'idle' && !dock.error()
            ? 'Hold to talk, or type…'
            : `${dock.error() ?? dock.status()} · type to add`
          : 'Type, paste a screenshot, or hold to talk…'
      }
      rows={1}
      submitShortcut="enter"
      value={draft()}
    />
  )
  const send = () => (
    <Button
      aria-label="Send to voice"
      class="size-7 shrink-0 rounded-lg pointer-coarse:size-9"
      disabled={!draft().trim() && !dock.pasted().length}
      onClick={() => {
        const text = draft()
        setDraft('')
        return sendTyped(text)
      }}
      size="icon"
      title="Send (Enter)"
      type="submit"
    >
      <ArrowUp class="size-4" />
    </Button>
  )
  return (
    <Form
      class={cn(
        'flex w-full flex-col rounded-xl border border-input/80 bg-card shadow-sm transition-colors focus-within:border-ring/70',
        recording() && 'border-error/40 focus-within:border-error/50',
      )}
      data-voice-prompt
    >
      <Pasted />
      <Show
        when={props.inline}
        fallback={
          <>
            <Show when={props.waveform && recording()} fallback={field()}>
              <div class="flex h-[38px] items-center px-3.5 pt-3 pb-1">
                <Waveform class="h-6 w-full text-error" live />
              </div>
            </Show>
            <div class="@container flex items-center justify-between gap-2 px-2 pt-1 pb-2">
              <div class="flex min-w-0 items-center gap-1 overflow-hidden">{props.tools}</div>
              <div class="flex min-w-0 shrink-0 items-center gap-1.5">
                {props.end}
                {send()}
              </div>
            </div>
          </>
        }
      >
        <div class="flex items-end gap-1.5 p-1.5">
          <div class="flex h-7 shrink-0 items-center">{props.start}</div>
          <div class="min-w-0 flex-1">
            <Show when={recording()} fallback={field()}>
              <div class="flex h-[30px] min-w-0 items-center gap-2 px-1">
                <Status class="shrink-0" />
                <Waveform class="h-5 min-w-0 flex-1 text-error" live />
              </div>
            </Show>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            {props.end}
            {send()}
          </div>
        </div>
      </Show>
    </Form>
  )
}

function PlaybackStrip() {
  const state = useExternal(dock.player.state.get, dock.player.state.subscribe)
  const [now, setNow] = createSignal(Date.now())
  createEffect(
    () => state().playing,
    (on) => (on ? every(200, () => setNow(Date.now())) : undefined),
  )
  const progress = createMemo(() => {
    const list = dock.player.items()
    const current = list[state().index]
    if (!current) return { done: 0, total: 1, paragraphs: 1, paragraph: 0 }
    const total = list.reduce((sum, item) => sum + estimate(item.text, dock.rate()), 0)
    const done =
      list
        .slice(0, state().index)
        .reduce((sum, item) => sum + estimate(item.text, dock.rate()), 0) +
      (state().playing
        ? Math.min(estimate(current.text, dock.rate()), (now() - state().startedAt) / 1000)
        : 0)
    return {
      done,
      total,
      paragraphs: new Set(list.map((item) => item.paragraph)).size,
      paragraph: current.paragraph,
    }
  })
  const step = (label: string, icon: JSX.Element, run: () => void) => (
    <Button
      aria-label={label}
      class={rowButton}
      onClick={() => run()}
      size={null}
      title={label}
      variant={null}
    >
      {icon}
    </Button>
  )
  return (
    <Show when={state().playing || state().paused}>
      <div
        class="relative flex min-w-0 items-center gap-2 overflow-hidden rounded-lg border border-border/70 bg-muted/30 px-2.5 py-1 font-mono text-[11px] text-muted-foreground"
        data-voice-playback
      >
        <AudioLines class="size-3.5 shrink-0 text-brand" />
        <span class="min-w-0 truncate tabular-nums">
          {state().paused ? 'Paused' : 'Speaking'} · ¶ {progress().paragraph + 1}/
          {progress().paragraphs}
          {state().streaming ? '+' : ''} · {state().index + 1}/{dock.player.items().length} · ~
          {Math.max(0, Math.round(progress().total - progress().done))} s
          {state().streaming ? ' · still writing' : ''}
        </span>
        <span class="ml-auto flex shrink-0 items-center gap-1">
          {step('Previous paragraph', <SkipBack />, () => dock.player.paragraph(-1))}
          {step('Previous sentence', <ChevronLeft />, () => dock.player.sentence(-1))}
          {step(
            state().playing ? 'Pause speech' : 'Resume speech',
            state().playing ? <Pause /> : <Play />,
            () => dock.player.toggle(),
          )}
          {step('Next sentence', <ChevronRight />, () => dock.player.sentence(1))}
          {step('Next paragraph', <SkipForward />, () => dock.player.paragraph(1))}
        </span>
        <i
          aria-hidden="true"
          class="absolute bottom-0 left-0 h-px bg-brand/70 transition-[width] duration-200 ease-linear"
          style={{
            width: `${Math.min(100, (progress().done / progress().total) * 100)}%`,
          }}
        />
      </div>
    </Show>
  )
}

function Bottom(props: { variant: Variant }) {
  return (
    <footer
      class="flex shrink-0 flex-col gap-1.5 px-4 pt-1 pb-3"
      data-voice-variant={props.variant}
    >
      <PlaybackStrip />
      <Switch>
        <Match when={props.variant === 'a'}>
          <PromptBox
            end={<MicButton />}
            tools={
              <>
                <VoiceModel class={toolbarButton} />
                <Settings />
              </>
            }
            waveform
          />
          <div class="flex min-w-0 items-center gap-3 pt-0.5">
            <Status class="flex-1" />
            <span class="shrink-0 font-mono text-[11px] text-muted-foreground/70 pointer-coarse:hidden">
              hold <Kbd>Space</Kbd> to talk
            </span>
          </div>
        </Match>
        <Match when={props.variant === 'b'}>
          <TalkBar />
          <PromptBox end={<Settings />} tools={<VoiceModel class={toolbarButton} />} />
        </Match>
        <Match when={props.variant === 'c'}>
          <PromptBox end={<Settings model />} inline start={<HoldPill />} />
        </Match>
      </Switch>
    </footer>
  )
}

function VariantSwitch(props: { bind: readonly [() => Variant, (value: Variant) => void] }) {
  return (
    <span
      class="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground/60"
      title="Temporary: compare the three bottom layouts, then this switch goes away"
    >
      variant
      <SegmentedControl
        aria-label="Bottom area variant (temporary)"
        bind={props.bind}
        class="border-dashed p-px"
      >
        <For each={variants}>
          {(option) => (
            <SegmentedControlItem class="h-5 px-1.5 text-[10.5px]" value={option}>
              {option.toUpperCase()}
            </SegmentedControlItem>
          )}
        </For>
      </SegmentedControl>
    </span>
  )
}

export function VoicePanel() {
  const session = useDocOf(() => ROOT, VoiceSessionDoc)
  const fork = useDocOf(() => session()?.id, VoiceForkDoc)
  const viewport = useViewport()
  const [stored, setVariant] = useExtensionUiState('variant', 'a')
  const variant = (): Variant => variants.find((option) => option === stored()) ?? 'a'
  const id = () => session()?.id
  onSettled(() => {
    const down = (event: KeyboardEvent) => {
      const editable = (event.target as HTMLElement | null)?.closest(
        'input, textarea, select, [contenteditable="true"]',
      )
      if (event.code === 'Space' && !event.repeat && !editable && voiceOpen()) {
        event.preventDefault()
        void press()
      }
    }
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space' && dock.mic.recording()) {
        event.preventDefault()
        void release()
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  })
  const phone = () => viewport() === 'phone'
  return (
    <Show when={voiceOpen()}>
      <section
        aria-label="Voice"
        class={cn(
          'pointer-events-auto fixed z-40 flex flex-col overflow-hidden border border-border bg-background shadow-2xl shadow-black/40',
          phone()
            ? 'inset-x-0 top-11 bottom-0 rounded-t-2xl border-b-0'
            : 'top-12 right-4 bottom-4 w-[min(40rem,46vw)] rounded-xl',
        )}
        data-voice-panel
      >
        <header class="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <AudioLines class="size-3.5 shrink-0 text-brand" />
          <span class="text-[13px] font-semibold">Voice</span>
          <span class="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            {id()
              ? `fork of @ultimate${fork()?.of ? ` #${fork()!.of}` : ''} · #${id()}`
              : 'forks @ultimate on your first turn'}
          </span>
          <span class="ml-auto flex shrink-0 items-center gap-1">
            <VariantSwitch bind={[variant, setVariant]} />
            <Show when={id()}>
              <Button
                aria-label="Open the voice conversation"
                class="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => switchConversation(id()!)}
                size={null}
                title="Open the voice conversation"
                variant={null}
              >
                <SquareArrowOutUpRight class="size-3.5" />
              </Button>
              <Button
                aria-label="End voice session"
                class="h-7 rounded-md px-2 font-mono text-[11px] font-normal text-muted-foreground hover:bg-error/10 hover:text-error"
                onClick={() => endSession()}
                size={null}
                title="End the session: the fork concludes and the next turn forks @ultimate again"
                variant={null}
              >
                end
              </Button>
            </Show>
            <Button
              aria-label="Close voice"
              class="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setVoiceOpen(false)}
              size={null}
              title={`Close · ${keys()}`}
              variant={null}
            >
              <X class="size-3.5" />
            </Button>
          </span>
        </header>
        <Show
          when={id()}
          fallback={
            <div class="flex flex-1 flex-col items-center justify-center gap-1.5 px-10 text-center">
              <AudioLines class="mb-1 size-5 text-brand" />
              <p class="text-[14px] text-foreground">Think out loud with @ultimate</p>
              <p class="max-w-sm text-[13px] text-muted-foreground">
                Hold <Kbd>Space</Kbd> or the mic and talk. Voice forks @ultimate with everything it
                knows, talks it through with you, and hands the result back when you agree.
              </p>
            </div>
          }
        >
          {(open) => (
            <ScopedConversation id={open()}>
              <Session fork={open()} />
            </ScopedConversation>
          )}
        </Show>
        <Bottom variant={variant()} />
      </section>
    </Show>
  )
}

export function VoiceToggle() {
  const session = useDocOf(() => ROOT, VoiceSessionDoc)
  return (
    <Button
      aria-label={voiceOpen() ? 'Hide voice' : 'Open voice'}
      class={cn(
        'flex h-6 items-center gap-1.5 rounded-md px-1.5 font-mono text-[11px] font-normal text-muted-foreground hover:bg-accent hover:text-foreground',
        session()?.id !== undefined && 'text-brand',
      )}
      onClick={() => setVoiceOpen(!voiceOpen())}
      size={null}
      title={`Voice · ${keys()}`}
      variant={null}
    >
      <AudioLines class="size-3.5" />
      <Show when={session()?.id !== undefined}>
        <span class="size-1.5 rounded-full bg-brand motion-safe:animate-pulse" />
      </Show>
      voice
    </Button>
  )
}
