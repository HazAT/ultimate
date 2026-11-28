import {
  Check,
  CircleDashed,
  GitFork,
  Play,
  Settings2,
  SquareArrowOutUpRight,
  X,
} from '@lucide/solid'
import type { ConversationId } from '@earendil-works/pi-durable'
import { createEffect, createRoot, createSignal, For, onCleanup, onSettled, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Kbd } from '@/components/ui/kbd.solid.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import { Switch as Toggle } from '@/components/ui/switch.solid.tsx'
import {
  api,
  closePanel,
  cn,
  Composer,
  ComposerRedirect,
  ConversationTranscript,
  errorMessage,
  formatAgo,
  formatKeys,
  formatTime,
  openPanel,
  ROOT,
  ScopedConversation,
  switchConversation,
  useAction,
  useConversationId,
  useConversationSummary,
  useDocOf,
  useEvent,
  useExtensionUiState,
  useNow,
  usePanels,
  useSurface,
  useUiState,
  useViewport,
  writingAs,
} from '@/sdk/solid'
import type { ComposerTarget, SolidComposerProps } from '@/sdk/solid'
import { DictationOptions, shortcut, talkMode } from '../dictation/ui.solid.tsx'
import { QUIET_MINUTES } from './entries.shared.ts'
import {
  coldDraft,
  composeIn,
  dock,
  hideSideChat,
  KEYS,
  playerState,
  registerSideChatFallback,
  sendTyped,
  setScreen,
  setSideChatOpen,
  setSideChatSource,
  sideChatOpen,
  sideChatSink,
} from './dock.solid.tsx'
import { EndAction, PickAction, StatusAction, SideChatForkDoc, SideChatSessionDoc } from './refs.ts'
import type { SideChatSourceSession } from './refs.ts'
import { PickControl } from '../models/ui.solid.tsx'
import type { ModelPick } from '../models/ui.solid.tsx'
import {
  PlaybackBar,
  SOUND_BLOCKED,
  SpeakerBar,
  speech,
  SpeechOptions,
} from '../read-aloud/ui.solid.tsx'
import { PinnedQuestion } from './pinned.solid.tsx'
import {
  inboxChat,
  SOURCE_KEY,
  useForkable,
  useSideSession,
  useSideSource,
  useSourceName,
} from './side.solid.tsx'
import { closing } from './side.web.ts'
import { Voicing } from './turns.solid.tsx'
import { REST, settle, type Snap } from './sheet.web.ts'

const FULL_TOP = 36
const FULL_HEIGHT = `calc(100dvh - env(safe-area-inset-top) - ${FULL_TOP}px)`
export const PANEL = 'side-chat'
const SPLIT = '(min-width: 1280px)'
const [sheetRoom, setSheetRoom] = createRoot(() => createSignal(0))

const iconButton =
  'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-open:bg-accent data-open:text-foreground pointer-coarse:size-9'
const keys = () => formatKeys(KEYS).join('+')
const holdKeys = () => formatKeys(shortcut()).join('+')
const talkVerb = () => (talkMode() === 'tap' ? 'tap' : 'hold')

export function SheetComposer(props: SolidComposerProps) {
  const viewport = useViewport()
  return (
    <Show when={!props.dock && sideChatOpen() && viewport() === 'phone'} fallback={props.core}>
      <div aria-hidden="true" data-side-chat-sheet-room style={{ height: `${sheetRoom()}px` }} />
    </Show>
  )
}

function Settings() {
  return (
    <Popover>
      <PopoverTrigger aria-label="Side chat settings" class={iconButton} title="Side chat settings">
        <Settings2 class="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Side chat settings options"
        class="max-h-[70dvh] w-64 overflow-y-auto p-0 font-mono text-[11.5px]"
        side="bottom"
      >
        <div class="px-3 pt-2.5 pb-1 section-label">Side chat</div>
        <div class="flex flex-col gap-2.5 px-3 pt-1 pb-2.5 text-muted-foreground">
          <div class="flex flex-col gap-1">
            <label class="flex items-center justify-between gap-3 text-foreground">
              Conversation mode
              <Toggle
                aria-label="Conversation mode"
                bind={[dock.conversation, dock.setConversation]}
              />
            </label>
            <span class="text-[10.5px] leading-snug text-muted-foreground/70">
              Your message sends when you stop speaking, and replies are read aloud.
            </span>
          </div>
          <label class="flex items-center justify-between gap-3">
            Sound cues
            <Toggle aria-label="Side chat sound cues" bind={[dock.cuesOn, dock.setCuesOn]} />
          </label>
          <SpeechOptions name="Side chat" />
        </div>
        <DictationOptions name="Side chat" />
      </PopoverContent>
    </Popover>
  )
}

function PlaybackStrip() {
  return (
    <Show
      when={playerState().playing || playerState().paused}
      fallback={<SpeakerBar name="Side chat" />}
    >
      <PlaybackBar
        name="Side chat"
        status={
          playerState().blocked ? SOUND_BLOCKED : playerState().paused ? 'Paused' : 'Speaking'
        }
        toggle={() => speech.toggle()}
      />
    </Show>
  )
}

function Unblock() {
  return (
    <Show when={playerState().blocked}>
      <Button
        aria-label="Play the side chat's reply"
        class="h-6 min-w-0 justify-start gap-1.5 rounded-md px-1.5 font-mono text-[11px] font-normal text-brand hover:bg-brand/10"
        onClick={() => speech.resume()}
        size={null}
        variant={null}
      >
        <Play class="size-3 shrink-0" />
        <span class="truncate">{SOUND_BLOCKED}</span>
      </Button>
    </Show>
  )
}

function SetupList() {
  const status = useAction(StatusAction, null, { conversation: ROOT })
  const useDefault = async () => {
    await api.action(PickAction, { model: null }, { conversationId: ROOT })
    await status.refetch()
  }
  const items = () => {
    const data = status.data()
    const setup = data?.setup
    return setup
      ? [
          {
            label: 'Model',
            ...setup.model,
            ...(data.source === 'picked' ? { reset: true } : {}),
          },
          { label: 'Transcription', ...setup.transcription },
        ]
      : []
  }
  return (
    <Show when={items().some((item) => !item.ready)}>
      <ul
        class="mt-4 flex w-full max-w-sm flex-col gap-2 rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5 text-left"
        data-side-chat-setup
      >
        <For each={items()}>
          {(item) => (
            <li class="flex items-start gap-2 text-[12.5px] leading-snug">
              <Show
                when={item.ready}
                fallback={<CircleDashed class="mt-0.5 size-3.5 shrink-0 text-warning" />}
              >
                <Check class="mt-0.5 size-3.5 shrink-0 text-success" />
              </Show>
              <span class="flex min-w-0 flex-col gap-0.5">
                <span class="font-mono text-[11px] text-muted-foreground">{item.label}</span>
                <span class="text-foreground">{item.detail}</span>
                <Show when={item.fix}>
                  <span class="text-muted-foreground">{item.fix}</span>
                </Show>
                <Show when={'reset' in item}>
                  <Button
                    aria-label="Use default"
                    class="h-6 self-start rounded-md px-2 font-mono text-[11px] font-normal"
                    onClick={useDefault}
                    size={null}
                    variant="outline"
                  >
                    Use default
                  </Button>
                </Show>
              </span>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}

function useSideChatPick(open: () => ConversationId | undefined): ModelPick {
  const state = useDocOf(() => ROOT, SideChatSessionDoc)
  const status = useAction(StatusAction, null, {
    conversation: ROOT,
    on: () => [open(), state()?.model, state()?.thinking],
  })
  const ref = () => {
    const model = status.data()?.model
    if (!model) return undefined
    const at = model.indexOf('/')
    return { provider: model.slice(0, at), modelId: model.slice(at + 1) }
  }
  return {
    name: 'Side chat',
    ref,
    thinking: () => status.data()?.thinking,
    configure: async (change) => {
      await api.action(PickAction, change, { conversationId: ROOT })
      await status.refetch()
    },
  }
}

export function ClosingLine(props: {
  last: NonNullable<SideChatSourceSession['last']>
  source: string
}) {
  const text = () => closing(props.last, QUIET_MINUTES)
  return (
    <div class="flex flex-col items-center gap-0.5 px-4 pt-1 pb-3" data-side-chat-ended>
      <div
        class="flex w-full min-w-0 items-center gap-3 font-mono text-[11px] text-muted-foreground"
        data-closing-line={props.last.reason}
        data-ui="transcript-meta"
      >
        <hr class="h-px min-w-4 flex-1 border-0 border-t border-dashed border-border" />
        <span class="flex min-w-0 items-center gap-1.5">
          <GitFork class="size-3 shrink-0 text-brand" />
          <span class="shrink-0">concluded</span>
          <span class="shrink-0">· {formatTime(props.last.endedAt)}</span>
        </span>
        <hr
          aria-hidden="true"
          class="h-px min-w-4 flex-1 border-0 border-t border-dashed border-border"
        />
      </div>
      <p
        class={cn(
          'text-center font-mono text-[11px] text-muted-foreground/80',
          props.last.failed && 'text-error',
        )}
        title={props.last.failed}
      >
        {text().reason} · {props.last.summary ? `summary sent to ${props.source}` : text().handback}
      </p>
    </div>
  )
}

function Bottom(props: {
  fork: ConversationId | undefined
  ended: boolean
  source: ConversationId
  sourceLabel: string
}) {
  const chip = <PickControl pick={useSideChatPick(() => props.fork)} />
  const viewport = useViewport()
  const placeholder = () =>
    props.ended
      ? 'Your next message starts a fresh side chat…'
      : viewport() === 'phone'
        ? `Talk it through with ${props.sourceLabel}…`
        : `Talk it through with ${props.sourceLabel} · ${talkVerb()} ${holdKeys()} to speak…`
  const target = (): ComposerTarget => ({
    name: 'Side chat',
    placeholder: placeholder(),
    images: true,
    ...(dock.conversation() ? { dictation: sideChatSink } : {}),
    send: (text, images) => sendTyped(text, images),
    ...(props.fork === undefined ? { draft: coldDraft(props.source), toolbar: chip } : {}),
  })
  return (
    <footer class="flex shrink-0 flex-col gap-1.5 pt-1">
      <div class="flex flex-col gap-1.5 px-4 empty:hidden">
        <PlaybackStrip />
        <Unblock />
        <Show when={dock.error()}>
          <p class="font-mono text-[11px] break-words text-error" role="alert">
            {dock.error()}
          </p>
        </Show>
      </div>
      <Show
        when={props.fork}
        fallback={
          <ComposerRedirect value={target}>
            <Composer dock />
          </ComposerRedirect>
        }
      >
        {(fork) => (
          <ScopedConversation id={fork()}>
            <ComposerRedirect value={target}>
              <Composer dock />
            </ComposerRedirect>
          </ScopedConversation>
        )}
      </Show>
    </footer>
  )
}

function Header(props: {
  docked: boolean
  phone: boolean
  source?: ConversationId
  name?: string
  fork?: ConversationId
  onClose: () => void
  onDrag?: (event: PointerEvent & { currentTarget: HTMLElement }) => void
}) {
  const id = () => props.fork
  const fork = useDocOf(id, SideChatForkDoc)
  const now = useNow(30_000, () => id() !== undefined)
  const [ending, setEnding] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const startFresh = async () => {
    setEnding(true)
    setFailure(undefined)
    try {
      await api.action(EndAction, { source: props.source })
    } catch (error) {
      setFailure(errorMessage(error).replace(/^side-chat\/end: /, ''))
    } finally {
      setEnding(false)
    }
  }
  const meta = () => {
    const caught = fork()?.caughtUp
    return caught ? `caught up ${formatAgo(caught, now(), { ago: true })}` : 'hot'
  }
  return (
    <>
      <header
        class={cn(
          'flex shrink-0 items-center gap-1.5 pr-1 pl-3 select-none',
          id() === undefined && 'border-b border-border/60',
          props.phone ? 'h-9' : 'h-10',
          props.onDrag && !props.phone && 'cursor-grab touch-none active:cursor-grabbing',
        )}
        onPointerDown={(event) => props.onDrag?.(event)}
        title={props.onDrag && !props.phone ? 'Drag to move' : undefined}
      >
        <GitFork class="size-3.5 shrink-0 text-brand" />
        <span class="shrink-0 text-[13px] font-semibold">Side chat</span>
        <span class="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          · {props.name ?? '…'}
        </span>
        <span class="flex-1" />
        <span class="flex shrink-0 items-center gap-0.5">
          <Settings />
          <Show when={id() !== undefined && !props.phone && !props.docked}>
            <Button
              aria-label="Open the side chat as a conversation"
              class={iconButton}
              onClick={() => switchConversation(id()!)}
              size={null}
              title="Open the side chat as a conversation"
              variant={null}
            >
              <SquareArrowOutUpRight class="size-3.5" />
            </Button>
          </Show>
          <Button
            aria-label="Close side chat"
            class={iconButton}
            onClick={() => props.onClose()}
            size={null}
            title={`Close · ${keys()}`}
            variant={null}
          >
            <X class="size-3.5" />
          </Button>
        </span>
      </header>
      <Show when={id() !== undefined}>
        <div class="flex h-7 shrink-0 items-center gap-2 border-b border-border/60 px-3 font-mono text-[11px] text-muted-foreground">
          <span class="min-w-0 flex-1 truncate">{meta()}</span>
          <Button
            aria-label={`Start fresh: end side chat #${id()}`}
            class="h-6 px-1 font-mono text-[11px] font-normal text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            disabled={ending()}
            onClick={startFresh}
            size={null}
            title="End this side chat now; a summary goes back only if something was decided or left open"
            variant={null}
          >
            {ending() ? 'ending…' : 'start fresh'}
          </Button>
        </div>
      </Show>
      <Show when={failure()}>
        <p
          class="border-b border-border/60 px-3 py-1.5 font-mono text-[11px] break-words text-error"
          role="alert"
        >
          {failure()}
        </p>
      </Show>
    </>
  )
}

export function SideChatBody(props: {
  docked?: boolean
  phone?: boolean
  folded?: boolean
  source?: ConversationId
  onClose?: () => void
  onDrag?: (event: PointerEvent & { currentTarget: HTMLElement }) => void
}) {
  const source = useSideSource(() => props.source)
  const session = useSideSession(source)
  const name = useSourceName(source)
  const close = () => (props.onClose ? props.onClose() : hideSideChat())
  const surface = useSurface()
  const shownNow = useConversationId()
  const besideSource = () => surface() === 'agent' && shownNow() === source()
  const id = () => session()?.id
  const last = () => (id() === undefined ? session()?.last : undefined)
  const shown = () => id() ?? last()?.id
  const sourceLabel = () => name() ?? 'the source'
  let anchor: HTMLSpanElement | undefined
  const forkable = useForkable(source)
  const canCompose = () => id() !== undefined || forkable() === true
  useFocusWhenWanted(() => anchor?.parentElement ?? undefined, source, canCompose)
  return (
    <>
      <span class="hidden" ref={anchor} />
      <Header
        docked={!!props.docked}
        fork={id()}
        name={name()}
        onClose={close}
        onDrag={props.onDrag}
        phone={!!props.phone}
        source={source()}
      />
      <Show when={!props.folded}>
        <Show when={session()?.question !== undefined && id()}>
          {(open) => (
            <PinnedQuestion
              folded={props.source === undefined && besideSource()}
              fork={open()}
              message={session()!.question!}
            />
          )}
        </Show>
        <Show
          when={shown()}
          fallback={
            <div class="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto px-10 py-4 text-center *:first:mt-auto *:last:mb-auto">
              <GitFork class="mb-1 size-5 text-brand" />
              <p class="text-[14px] text-foreground">Think it through with {sourceLabel()}</p>
              <p class="max-w-sm text-[13px] text-muted-foreground">
                <Show when={forkable()}>
                  Type, or {talkVerb()} <Kbd>{holdKeys()}</Kbd> to speak.{' '}
                </Show>
                A side chat forks {sourceLabel()} with everything it knows, talks it through with
                you, and hands the result back when you agree.
              </p>
              <SetupList />
            </div>
          }
        >
          {(fork) => (
            <ScopedConversation id={fork()}>
              <ConversationTranscript dock />
            </ScopedConversation>
          )}
        </Show>
        <Show when={last()}>
          {(ended) => <ClosingLine last={ended()} source={sourceLabel()} />}
        </Show>
      </Show>
      <Show when={source()} keyed>
        {(at) => (
          <Show
            when={canCompose()}
            fallback={
              <Show when={forkable() === false}>
                <p
                  class="shrink-0 px-4 pt-1 pb-3 text-center font-mono text-[11px] text-muted-foreground"
                  data-side-chat-unforkable
                >
                  {sourceLabel()} has no finished reply to fork yet
                </p>
              </Show>
            }
          >
            <Bottom ended={!!last()} fork={id()} source={at} sourceLabel={sourceLabel()} />
          </Show>
        )}
      </Show>
    </>
  )
}

function useSplit() {
  const [wide, setWide] = createSignal(matchMedia(SPLIT).matches)
  onSettled(() => {
    const query = matchMedia(SPLIT)
    const update = () => setWide(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  })
  const surface = useSurface()
  const shown = useConversationId()
  const source = useSideSource()
  return () => wide() && surface() === 'agent' && shown() !== undefined && shown() === source()
}

export function SideChatPanel() {
  return (
    <section
      aria-label="Side chat"
      class="flex h-full min-h-0 flex-col bg-background"
      data-side-chat-panel
      data-side-chat-docked
    >
      <SideChatBody docked />
    </section>
  )
}

export function SideChatOverlay() {
  const source = useSideSource(() => inboxChat()?.source)
  const session = useSideSession(source)
  const sessions = useDocOf(() => ROOT, SideChatSessionDoc)
  const forkable = useForkable(source)
  const viewport = useViewport()
  const id = () => session()?.id
  const surface = useSurface()
  const shown = useConversationId()
  const summary = useConversationSummary(shown)
  const status = useAction(StatusAction, null, { conversation: ROOT })
  const split = useSplit()
  const panels = usePanels()
  const [selectedPanel, selectPanel] = useUiState<string | null>('shell.panel', null)
  const [released, setReleased] = createSignal(false)
  const docked = () => sideChatOpen() && split() && !released()
  useEvent('secrets:changed', () => void status.refetch())
  createEffect(
    () => [source(), id(), sessions()?.sessions] as const,
    ([from, fork, current], previous) => {
      const [priorSource, priorFork] = previous ?? []
      if (
        priorSource !== undefined &&
        priorSource !== from &&
        priorFork !== undefined &&
        current?.[priorSource]?.last?.id === priorFork
      )
        composeIn(undefined)
      setSideChatSource(from)
      composeIn(fork)
    },
  )
  createEffect(
    () => status.data()?.transcribes,
    (known) => {
      if (known !== undefined) speech.setKeyed(known)
    },
  )
  type Region = { panel: string | null; open: boolean }
  let before: Region | undefined
  let restored: Region | undefined
  let was: { want: boolean; open: boolean; holds: boolean } | undefined
  createEffect(
    () => ({
      want: sideChatOpen() && split(),
      open: sideChatOpen(),
      selected: selectedPanel(),
      shown: panels.open(),
    }),
    (now) => {
      const holds = now.shown && now.selected === PANEL
      if (holds) setReleased(false)
      const previous = was ?? { want: false, open: now.open, holds }
      was = { want: now.want, open: now.open, holds }
      const region = { panel: now.selected, open: now.shown }
      if (now.want && !previous.want) {
        const free =
          !now.shown || holds || (restored?.panel === region.panel && restored.open === region.open)
        restored = undefined
        if (!free && previous.open) {
          setReleased(true)
          return
        }
        setReleased(false)
        before = { panel: now.selected === PANEL ? null : now.selected, open: now.shown }
        writingAs('app', () => openPanel(PANEL))
        return
      }
      if (now.want && previous.holds && !holds) {
        const back = before
        before = undefined
        setReleased(true)
        if (back && now.selected === PANEL) writingAs('app', () => selectPanel(back.panel))
        return
      }
      if (now.want || !previous.want) return
      setReleased(false)
      const back = before
      before = undefined
      if (!back) return
      restored = back
      writingAs('app', () => {
        selectPanel(back.panel)
        if (back.open) openPanel()
        else closePanel()
      })
    },
  )
  createEffect(
    () => [surface(), shown(), summary()?.title] as const,
    ([on, conversation, title]) => {
      const showing = on === 'agent' ? conversation : undefined
      setScreen({
        text: `The user's screen: the ${on} surface${
          showing !== undefined
            ? `, showing conversation #${showing}${title ? ` "${title}"` : ''}`
            : ''
        }.`,
        ...(showing !== undefined ? { conversation: showing } : {}),
      })
    },
  )
  onSettled(() => registerSideChatFallback(() => id() !== undefined || forkable() === true))
  const phone = () => viewport() === 'phone'
  const floating = () => sideChatOpen() && !docked() && inboxChat() === undefined
  const [place, setPlace] = useExtensionUiState<{
    right: number
    bottom: number
  } | null>('corner', null)
  const [snapped, setSnap] = useExtensionUiState<Snap>('sheet', 'rest')
  const snap = () => snapped() as Snap
  const [dragged, setDragged] = createSignal<number>()
  let sheet: HTMLElement | undefined
  let observer: ResizeObserver | undefined
  onCleanup(() => observer?.disconnect())
  const measure = (element: HTMLElement) => {
    observer?.disconnect()
    observer = new ResizeObserver(() => {
      const line = document.querySelector<HTMLElement>('[data-ui="status-line"]')
      const room = element.offsetHeight - (line?.offsetHeight ?? 0)
      setSheetRoom(Math.max(0, Math.min(room, window.innerHeight * REST)))
    })
    observer.observe(element)
  }
  let swiped = false
  let endSwipe: (() => void) | undefined
  onCleanup(() => endSwipe?.())
  const swipe = (event: PointerEvent & { currentTarget: HTMLElement }) => {
    swiped = false
    if (
      (event.target as HTMLElement).closest(
        'button:not([data-side-chat-grabber]), [popover], textarea',
      )
    )
      return
    const handle = event.currentTarget
    const finger = event.pointerId
    endSwipe?.()
    const start = sheet!.offsetHeight
    const full = sheet!.getBoundingClientRect().bottom - FULL_TOP
    const y = event.clientY
    let last = { y, at: event.timeStamp }
    let velocity = 0
    let moving = false
    const move = (next: PointerEvent) => {
      if (next.pointerId !== finger) return
      const pulled = y - next.clientY
      if (!moving && Math.abs(pulled) < 6) return
      if (!moving) handle.setPointerCapture(next.pointerId)
      moving = true
      swiped = true
      const span = next.timeStamp - last.at
      if (span > 0) velocity = (last.y - next.clientY) / span
      last = { y: next.clientY, at: next.timeStamp }
      setDragged(Math.max(72, Math.min(full, start + pulled)))
    }
    const hold = (next: TouchEvent) => moving && next.preventDefault()
    const stop = () => {
      window.removeEventListener('touchmove', hold)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      endSwipe = undefined
    }
    const up = (next: PointerEvent) => {
      if (next.pointerId !== finger) return
      stop()
      const height = dragged()
      setDragged(undefined)
      if (!moving || height === undefined) return
      setSnap(
        settle(snap(), height, start, velocity, {
          folded: 120,
          rest: window.innerHeight * REST,
          full,
        }),
      )
    }
    window.addEventListener('touchmove', hold, { passive: false })
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    endSwipe = stop
  }
  const sheetHeight = () => {
    const px = dragged()
    if (px !== undefined) return `${px}px`
    if (snap() === 'folded') return undefined
    if (snap() === 'full') return FULL_HEIGHT
    return `${REST * 100}dvh`
  }
  const drag = (event: PointerEvent & { currentTarget: HTMLElement }) => {
    if (phone()) return swipe(event)
    if ((event.target as HTMLElement).closest('button, [popover], label')) return
    const panel = event.currentTarget.closest<HTMLElement>('[data-side-chat-panel]')!
    const box = panel.getBoundingClientRect()
    const right = window.innerWidth - box.right
    const bottom = window.innerHeight - box.bottom
    const x = event.clientX
    const y = event.clientY
    event.currentTarget.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent) =>
      setPlace({
        right: Math.max(8, Math.min(window.innerWidth - box.width - 8, right - (next.clientX - x))),
        bottom: Math.max(8, Math.min(window.innerHeight - 48, bottom - (next.clientY - y))),
      })
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const style = () => {
    const at = place()
    if (phone()) return { height: sheetHeight(), 'max-height': FULL_HEIGHT }
    if (!at) return undefined
    return {
      right: `min(${at.right}px, 100vw - min(36rem, 46vw) - 0.5rem)`,
      bottom: `min(${at.bottom}px, 100vh - min(44rem, 100vh - 5rem) - 3rem)`,
    }
  }
  return (
    <>
      <Show when={id()} keyed>
        {(open) => (
          <ScopedConversation id={open}>
            <Voicing fork={open} />
          </ScopedConversation>
        )}
      </Show>
      <Show when={floating()}>
        <section
          aria-label="Side chat"
          class={cn(
            'pointer-events-auto fixed z-40 flex flex-col overflow-hidden border border-border bg-background shadow-2xl shadow-black/40',
            phone()
              ? cn(
                  dragged() === undefined &&
                    'transition-[height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
                  'inset-x-0 bottom-0 rounded-t-2xl border-x-0 border-b-0 border-t-brand/40 pb-[env(safe-area-inset-bottom)] has-[textarea:focus]:pb-0',
                )
              : 'right-4 bottom-4 h-[min(44rem,calc(100vh-5rem))] w-[min(36rem,46vw)] rounded-xl',
          )}
          data-side-chat-panel
          data-side-chat-sheet={phone() ? snap() : undefined}
          ref={(element) => {
            sheet = element
            measure(element)
          }}
          style={style()}
        >
          <Show when={phone()}>
            <div
              class="flex h-5 shrink-0 touch-none items-center justify-center select-none"
              onPointerDown={drag}
            >
              <Button
                aria-label={snap() === 'full' ? 'Shrink side chat' : 'Expand side chat'}
                class="flex h-5 w-16 items-center justify-center"
                data-side-chat-grabber
                onClick={() => !swiped && setSnap(snap() === 'full' ? 'rest' : 'full')}
                size={null}
                variant={null}
              >
                <span class="h-1 w-9 rounded-full bg-muted-foreground/40" />
              </Button>
            </div>
          </Show>
          <SideChatBody folded={phone() && snap() === 'folded'} onDrag={drag} phone={phone()} />
        </section>
      </Show>
    </>
  )
}

const [focusWanted, wantFocus] = createRoot(() => createSignal(false))
const [, setSource] = createRoot(() => useUiState<number | null>(SOURCE_KEY, null))

export function openSideChat(source?: ConversationId) {
  inboxChat()?.park()
  if (source !== undefined) setSource(source)
  setSideChatOpen(true)
  focusSideChat()
}

export function focusSideChat() {
  wantFocus(true)
}

function useFocusWhenWanted(
  section: () => HTMLElement | undefined,
  source: () => ConversationId | undefined,
  canCompose: () => boolean,
) {
  let waited = false
  createEffect(
    () => [focusWanted(), source(), canCompose()] as const,
    ([wanted]) => {
      if (!wanted) return
      const box = section()?.querySelector<HTMLTextAreaElement>('[data-ui="composer"] textarea')
      if (!box) {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        waited = true
        return
      }
      const movedOn = waited && document.activeElement !== document.body
      waited = false
      if (!movedOn) box.focus()
      wantFocus(false)
    },
  )
}
