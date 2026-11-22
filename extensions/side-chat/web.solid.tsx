import type { ConversationId } from '@earendil-works/pi-durable'
import {
  ChevronDownIcon,
  GitForkIcon,
  LoaderCircleIcon,
  MessageCircleQuestionIcon,
  MinimizeIcon,
  SparklesIcon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
} from '@lucide/solid'
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import type { JSX } from '@solidjs/web'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import {
  Card,
  Conversation,
  renderEntry,
  ScopedConversation,
  api,
  cn,
  defineWebExtension,
  EmptyTranscript,
  errorMessage,
  formatTime,
  provide,
  ROOT,
  showSurface,
  switchConversation,
  useConversation,
  useConversationId,
  useConversationWidth,
  useConversations,
  useDoc,
  useDocOf,
  useExternal,
  useSurface,
  useUiState,
  useViewport,
  writerNow,
  writingAs,
} from '@/sdk/solid'
import { deadline } from '../../lib/timers.ts'
import { QuestionPane } from '../inbox/ui.solid.tsx'
import { MessagesDoc } from '../messages/refs.ts'
import type { Reply } from '../questions/refs.ts'
import {
  answered,
  CardActions,
  cardKey,
  cardOf,
  CARDS_KEY,
  MessageQuestions,
} from '../questions/ui.solid.tsx'
import type { CardState, QuestionMessage } from '../questions/ui.solid.tsx'
import { UnderUltimate, Unlisted } from '../sidebar/ui.solid.tsx'
import { talkToUltimate } from '../subagents/ui.solid.tsx'
import { SideChatSummaryEntry } from './entries.ts'
import { ComposerFrame, ease } from './frame.solid.tsx'
import {
  contextSize,
  createEndings,
  endings,
  frontSide,
  openQuestionSide,
  openSides,
} from './logic.ts'
import {
  DiscardAction,
  InjectAction,
  OpenAction,
  QuestionSidesDoc,
  SideChatDoc,
  SideChatsDoc,
} from './refs.ts'
import type { SideChatIndex } from './refs.ts'
import { useSideChatFront } from './ui.solid.tsx'

const sideEndings = createEndings(errorMessage)
const sheetTransitionMs = 420
const unmountAfterExitPaddingMs = 60
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

function Stage() {
  const id = useConversationId()
  const index = useDocOf(id, SideChatsDoc)
  const hasSides = createMemo(() => openSides(index() ?? undefined).length > 0)
  return (
    <Show when={hasSides()}>
      <SideStage id={id()} index={index() ?? undefined} />
    </Show>
  )
}

function SideStage(props: { id?: ConversationId; index?: SideChatIndex }) {
  const [front, setFront] = useSideChatFront()
  const viewport = useViewport()
  const phone = createMemo(() => viewport() === 'phone')
  let overlay!: HTMLDivElement
  const width = useConversationWidth(() => overlay)
  const current = () => frontSide(front(), props.index)
  const currentId = createMemo(() => current()?.id)
  const inFront = createMemo(() => currentId() !== undefined)
  const [previous, setPrevious] = createSignal<ConversationId>()
  const mounted = () => currentId() ?? previous()
  createEffect(currentId, (side) => {
    if (side !== undefined) {
      setPrevious(side)
      return undefined
    }
    return deadline(sheetTransitionMs + unmountAfterExitPaddingMs, () => setPrevious(undefined))
  })

  createEffect(
    () => ({ active: inFront(), width: width(), phone: phone() }),
    ({ active, width: availableWidth, phone: narrow }) => {
      const parent = overlay.closest<HTMLElement>('[data-ui="conversation"]')
      if (!parent || !active) return undefined
      const layers = [...parent.children].filter(
        (child): child is HTMLElement =>
          child instanceof HTMLElement &&
          !child.querySelector('[data-ui="conversation"]') &&
          (child.matches('[data-ui="composer"]') ||
            !!child.querySelector('[data-ui="transcript"], [data-ui="composer"]')),
      )
      const still = reduced()
      const reading = layers
        .map((layer) => layer.querySelector<HTMLElement>('[data-ui="transcript"]'))
        .find(Boolean)
      const userConfiguredReadingWidth = reading?.offsetWidth ?? availableWidth
      const scale = narrow ? 0.92 : 0.88
      const restBesideSheetX = narrow
        ? 0
        : Math.min(0, 24 - (availableWidth / 2 - (userConfiguredReadingWidth / 2) * scale))
      for (const layer of layers) {
        layer.style.transition = still
          ? `opacity ${sheetTransitionMs}ms ease`
          : `transform ${sheetTransitionMs}ms ${ease}, opacity ${sheetTransitionMs}ms ease, filter ${sheetTransitionMs}ms ease`
        layer.style.transformOrigin = `50% ${(narrow ? 0 : parent.clientHeight / 2) - layer.offsetTop}px`
        layer.style.transform = still
          ? ''
          : narrow
            ? `translateY(10px) scale(${scale})`
            : `translateX(${restBesideSheetX}px) scale(${scale})`
        layer.style.opacity = narrow ? '0.45' : still ? '0.5' : '0.62'
        layer.style.filter = 'saturate(0.7)'
        layer.setAttribute('data-receded', '')
        if (layer.querySelector('[data-ui="transcript"]')) layer.inert = true
      }
      return () => {
        for (const layer of layers) {
          layer.inert = false
          layer.removeAttribute('data-receded')
          layer.style.transform = ''
          layer.style.opacity = ''
          layer.style.filter = ''
        }
      }
    },
  )

  const still = () => reduced()
  const away = () => (phone() ? 'translateY(105%)' : 'translateX(14%) scale(0.96)')
  return (
    <div class="pointer-events-none absolute inset-0 z-20 overflow-hidden" ref={overlay}>
      <Show when={inFront() && phone()}>
        <Button
          aria-label="Show main conversation, keep the side chat"
          class="pointer-events-auto absolute inset-x-0 top-0 flex h-11 items-center justify-center gap-2 rounded-none bg-gradient-to-b from-background via-background/90 to-background/40 font-mono text-[11px] font-normal text-muted-foreground"
          onClick={() => setFront(null)}
          size={null}
          variant={null}
        >
          <span class="size-1.5 rounded-full bg-brand motion-safe:animate-pulse" />
          {current()?.question === undefined
            ? '@ultimate keeps working'
            : `#${props.id} waits`} ·{' '}
          <span class="text-foreground">show main</span>
        </Button>
      </Show>
      <Show when={mounted()} keyed>
        {(side) => (
          <section
            aria-label="Side chat"
            class={cn(
              'absolute flex flex-col overflow-hidden border border-border bg-background shadow-2xl shadow-black/40',
              inFront() && 'pointer-events-auto',
              phone()
                ? 'inset-x-0 top-11 bottom-0 rounded-t-2xl border-b-0'
                : 'top-3 right-5 bottom-3 rounded-xl',
            )}
            data-side-chat={side}
            inert={!inFront()}
            style={{
              width: phone() ? undefined : `min(44rem, ${Math.round(width() * 0.6)}px)`,
              transition: still()
                ? `opacity ${sheetTransitionMs}ms ease`
                : `transform ${sheetTransitionMs}ms ${ease}, opacity ${sheetTransitionMs}ms ease`,
              transform: inFront() || still() ? 'none' : away(),
              opacity: inFront() ? 1 : 0,
            }}
          >
            <ScopedConversation id={side}>
              <SidePane
                front={inFront()}
                index={props.index}
                onPark={() => setFront(null)}
                phone={phone()}
                side={side}
              />
            </ScopedConversation>
          </section>
        )}
      </Show>
    </div>
  )
}

function SidePane(props: {
  side: ConversationId
  index?: SideChatIndex
  front: boolean
  phone: boolean
  onPark: () => void
}) {
  const state = useDoc(SideChatDoc)
  const conversation = useConversation()
  const can = createMemo(() => endings(state() ?? undefined))
  const endingState = useExternal(() => sideEndings.get(props.side), sideEndings.subscribe)
  const ending = () => endingState().ending
  const error = () => endingState().error
  const openedAt = () => props.index?.sides.find((item) => item.id === props.side)?.openedAt
  createEffect(
    () => (props.front ? props.side : undefined),
    (side) => {
      if (side !== undefined) document.getElementById(`composer-input-${side}`)?.focus()
    },
  )
  const end = (how: 'discard' | 'inject') => {
    const id = props.side
    return sideEndings.end(id, how, () =>
      api.action(how === 'inject' ? InjectAction : DiscardAction, { id }),
    )
  }
  const question = () => state()?.question
  const asker = () => state()?.of
  const owner = () => (question() === undefined ? 'main' : 'the question')
  return (
    <>
      <header class="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <GitForkIcon class="size-3.5 text-brand" />
        <span class="text-[13px] font-semibold">Side chat</span>
        <span class="truncate font-mono text-[11px] text-muted-foreground">
          {question() === undefined
            ? 'temporary copy of @ultimate'
            : `read-only copy of #${asker()}${state()?.tokens ? ` · ${contextSize(state()!.tokens!)} context` : ''}`}
        </span>
        <Button
          aria-label={`Back to ${owner()}, keep side chat #${props.side}`}
          class="ml-auto flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          onClick={() => props.onPark()}
          size={null}
          title={`Back to ${owner()} · keeps the side chat`}
          variant={null}
        >
          <MinimizeIcon class="size-3.5" />
        </Button>
      </header>
      <Show when={openedAt()}>
        {(at) => <Cut at={at()} from={question() === undefined ? '@ultimate' : `#${asker()}`} />}
      </Show>
      <Show when={question()}>
        {(id) => (
          <PinnedQuestion
            answerWith={(answer, keepalive) =>
              api
                .action(InjectAction, { id: props.side, answer }, { keepalive })
                .catch((failure: unknown) => {
                  throw new Error(
                    `Nothing was sent: ${errorMessage(failure).replace(/^side-chat\/\w+: /, '')}`,
                  )
                })
            }
            keys={props.front && !props.phone}
            message={id()}
          />
        )}
      </Show>
      <Conversation variant={props.phone ? 'dock' : 'main'} />
      <footer
        class={cn('shrink-0 border-t border-border/60 py-2', props.phone ? 'px-3' : 'px-5')}
        data-side-chat-actions
      >
        <Show when={error()}>
          <p class="pb-2 font-mono text-[11px] break-words text-error" role="alert">
            {error()}
          </p>
        </Show>
        <div class="flex items-center gap-2">
          <span class="mr-auto min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            {can().locked
              ? 'This side chat changed things · summarize to keep main informed'
              : props.phone
                ? 'End it with'
                : question() === undefined
                  ? 'Main keeps running · end it with'
                  : `#${asker()} waits for your answer · end it with`}
          </span>
          <Show when={can().discard}>
            <Button
              aria-label={`Discard side chat #${props.side}`}
              class="text-muted-foreground"
              data-agent-confirm="Discards this side chat without sending a summary."
              disabled={ending() !== undefined}
              onClick={() => void end('discard')}
              size="sm"
              title={
                question() === undefined
                  ? 'Throw it away; main never hears of it'
                  : `Throw it away; #${asker()} never hears of it`
              }
              variant="ghost"
            >
              <Show when={ending() === 'discard'} fallback={<Trash2Icon />}>
                <LoaderCircleIcon class="motion-safe:animate-spin" />
              </Show>
              Discard
            </Button>
          </Show>
          <Button
            aria-label={`Summarize side chat #${props.side}`}
            class="border-brand/50 text-foreground hover:border-brand"
            disabled={!can().inject || ending() !== undefined}
            onClick={() => void end('inject')}
            size="sm"
            title={
              question() !== undefined
                ? `Send #${asker()} a summary without answering yet; answer on the card to send both`
                : conversation().busy
                  ? 'Stops the side chat, then sends main a summary'
                  : 'Send main a summary it reads with its next input'
            }
            variant="outline"
          >
            <Show when={ending() === 'inject'} fallback={<SparklesIcon class="text-brand" />}>
              <LoaderCircleIcon class="text-brand motion-safe:animate-spin" />
            </Show>
            {ending() === 'inject'
              ? 'Summarizing…'
              : error()
                ? 'Retry summary'
                : question() === undefined
                  ? 'Summarize & inject'
                  : 'Summarize only'}
          </Button>
        </div>
      </footer>
    </>
  )
}

function PinnedQuestion(props: {
  message: number
  keys: boolean
  answerWith: (answer: Reply, keepalive?: boolean) => Promise<unknown>
}) {
  const log = useDocOf(() => ROOT, MessagesDoc)
  const message = () => log()?.messages.find((item) => item.id === props.message)
  const [cards] = useUiState<Record<string, CardState>>(CARDS_KEY, {})
  const [open, setOpen] = createSignal(false)
  const questions = () => message()?.questions ?? []
  const ready = () =>
    answered(questions(), cardOf(cards(), cardKey(props.message), questions()).drafts).length
  const waits = () => message()?.state === 'delivered'
  const settled = () =>
    message()?.state === 'dismissed'
      ? 'dismissed · the asker knows'
      : 'answered · the asker has your answer'
  const lead = () =>
    message()
      ?.text.split('\n')
      .find((line) => line.trim()) ?? ''
  return (
    <Show when={message()}>
      {(question) => (
        <Collapsible
          bind={[open, setOpen]}
          class="mx-3 mt-2 flex max-h-[45%] shrink-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-card/60"
          data-pinned-question={props.message}
          render={(panel) => <section {...panel} />}
        >
          <CollapsibleTrigger
            aria-label={`Pinned question #${props.message}`}
            class="group/question flex w-full shrink-0 items-center justify-start gap-2 rounded-none px-3 py-1.5 text-left font-mono text-[11px] font-normal whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <MessageCircleQuestionIcon class="size-3.5 shrink-0 text-brand" />
            <span class="min-w-0 flex-1 truncate">
              {waits() ? lead().replace(/\*\*/g, '') : settled()}
            </span>
            <Show when={waits() && !open()}>
              <span class="shrink-0 text-brand">
                {questions().length
                  ? `${ready()}/${questions().length} · ${ready() ? 'review & send' : 'answer'}`
                  : 'answer'}
              </span>
            </Show>
            <ChevronDownIcon class="size-3.5 shrink-0 transition-transform group-data-closed/question:-rotate-90" />
          </CollapsibleTrigger>
          <CollapsibleContent class="min-h-0 overflow-y-auto">
            <Show when={waits()}>
              <MessageQuestions
                answerWith={props.answerWith}
                keys={props.keys}
                message={question()}
                sendLabel="Summarize & send"
                withActions={false}
              />
            </Show>
          </CollapsibleContent>
        </Collapsible>
      )}
    </Show>
  )
}

function TalkItThrough(props: { message: QuestionMessage }) {
  const questionSides = useDocOf(() => ROOT, QuestionSidesDoc)
  const [, setFront] = useSideChatFront()
  const [opening, setOpening] = createSignal(false)
  const surface = useSurface()
  const shown = useConversationId()
  const asker = () =>
    typeof props.message.from === 'number' ? (props.message.from as ConversationId) : undefined
  const open = () => openQuestionSide(questionSides()?.sides, props.message.id)
  const talk = async (from: ConversationId, message: number) => {
    const who = writerNow()
    setOpening(true)
    try {
      const { id } = await api.action(OpenAction, { message })
      const showAsker = surface() === 'agent' && shown() !== from
      writingAs(who, () => {
        setFront(id)
        if (showAsker) switchConversation(from)
      })
    } finally {
      setOpening(false)
    }
  }
  return (
    <Show when={asker()}>
      {(asking) => (
        <Button
          aria-label={`Talk through question #${props.message.id}`}
          class="text-muted-foreground"
          data-talk-it-through={props.message.id}
          disabled={opening()}
          onClick={() => talk(asking(), props.message.id)}
          size="sm"
          title={
            open()
              ? 'Back to the side chat where you are talking this question through'
              : 'Talk this question through in a read-only side chat forked from the agent that asked it'
          }
          variant="ghost"
        >
          <Show when={opening()} fallback={<GitForkIcon class="text-brand" />}>
            <LoaderCircleIcon class="motion-safe:animate-spin" />
          </Show>
          Talk it through
        </Button>
      )}
    </Show>
  )
}

function inboxSideChat(input: () => { message: QuestionMessage | undefined; phone: boolean }) {
  const sides = useDocOf(() => ROOT, QuestionSidesDoc)
  const [front, setFront] = useSideChatFront()
  const side = () => sides()?.sides.find((item) => item.id === front() && item.ended === undefined)
  const index = useDocOf(() => side()?.of, SideChatsDoc)
  const sideId = createMemo(() => side()?.id)
  return createMemo(() => {
    const staticId = sideId()
    if (staticId === undefined) return undefined
    return () => (
      <section
        aria-label="Side chat"
        class="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
        data-side-chat={staticId}
      >
        <ScopedConversation id={staticId}>
          <SidePane
            front
            index={index() ?? undefined}
            onPark={() => setFront(null)}
            phone={input().phone}
            side={staticId}
          />
        </ScopedConversation>
      </section>
    )
  })
}

function QuestionSideStart(props: { conversation: ConversationId; core: JSX.Element }) {
  const side = useDocOf(() => props.conversation, SideChatDoc)
  const log = useDocOf(() => ROOT, MessagesDoc)
  const message = () => log()?.messages.find((item) => item.id === side()?.question)
  const conversations = useConversations()
  const asker = () => conversations().find((item) => item.id === side()?.of)
  return (
    <Show when={side()?.question !== undefined && message()} fallback={props.core}>
      {(question) => (
        <div class="mx-auto w-full max-w-2xl px-5 pt-14 pb-2" data-question-side-start>
          <p class="font-mono text-[11px] text-muted-foreground">
            #{side()?.of}
            {asker()?.title ? ` · ${asker()?.title}` : ''} asked you, and knows everything that led
            here:
          </p>
          <div class="mt-2 border-l-2 border-brand/50 pl-3 text-[13px] leading-relaxed text-muted-foreground [&_p]:my-1">
            <Markdown text={question().text} />
          </div>
          <p class="mt-3 font-mono text-[11px] text-muted-foreground/70">
            Ask why, what an option means, or say what to pick.
          </p>
        </div>
      )}
    </Show>
  )
}

function Cut(props: { at: number; from: string }) {
  return (
    <div class="flex shrink-0 items-center gap-3 px-5 pt-3 font-mono text-[11px] text-muted-foreground">
      <hr class="h-px flex-1 border-0 border-t border-dashed border-border" />
      <span class="flex shrink-0 items-center gap-1.5">
        <GitForkIcon class="size-3 text-brand" />
        forked from {props.from} at {formatTime(props.at)}
        <span class="max-sm:hidden">· knows everything up to here</span>
      </span>
      <hr aria-hidden="true" class="h-px flex-1 border-0 border-t border-dashed border-border" />
    </div>
  )
}

const SummaryCard = renderEntry(SideChatSummaryEntry, function SummaryCard(props) {
  const data = () => props.entry.data
  const index = useDocOf(() => data().to, SideChatsDoc)
  const openedAt = () => index()?.sides.find((item) => item.id === data().side)?.openedAt
  const at = () => props.entry.model?.[0]?.timestamp
  return (
    <Card data-side-chat-summary={data().side}>
      <header class="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <GitForkIcon class="size-3.5 text-brand" />
        <span class="text-foreground">Side chat</span>
        <span>summary</span>
        <Show when={openedAt() !== undefined && at() !== undefined}>
          <span>
            {formatTime(openedAt()!)}–{formatTime(at()!)}
          </span>
        </Show>
        <Button
          aria-label={`Read side chat #${data().side} from summary #${props.entry.id}`}
          class="ml-auto flex gap-1 rounded-none font-mono text-[11px] font-normal hover:text-foreground"
          onClick={() => switchConversation(data().side)}
          size={null}
          title={`Read side chat #${data().side}`}
          variant={null}
        >
          <SquareArrowOutUpRightIcon class="size-3" />
          side chat
        </Button>
      </header>
      <div class="min-w-0 px-3 py-3 font-sans text-[13px] leading-relaxed">
        <Markdown text={data().text} />
      </div>
    </Card>
  )
})

function SideRows(props: { conversation: ConversationId | undefined }) {
  const index = useDocOf(() => props.conversation, SideChatsDoc)
  const [front, setFront] = useSideChatFront()
  const shown = useConversationId()
  const surface = useSurface()
  const conversations = useConversations()
  const sides = createMemo(() => openSides(index() ?? undefined))
  const mainShown = () => surface() === 'agent' && shown() === props.conversation
  return (
    <Show when={props.conversation !== undefined && sides().length > 0}>
      <fieldset aria-label="Side chats" class="flex min-w-0 flex-col gap-px">
        <For each={sides()} keyed={(item) => item.id}>
          {(item) => {
            const inFront = () => item().id === front() && mainShown()
            const working = () =>
              conversations().find((conversation) => conversation.id === item().id)?.busy
            return (
              <Button
                aria-current={inFront() ? 'true' : undefined}
                aria-label={`${inFront() ? 'Park' : 'Open'} side chat #${item().id}`}
                class={cn(
                  'mx-2 flex w-[calc(100%-1rem)] items-center justify-start gap-1.5 rounded-md py-1.5 pr-2 pl-9 text-left font-normal outline-none hover:bg-sidebar-accent/50 focus-visible:ring-1 focus-visible:ring-ring',
                  inFront() && 'bg-sidebar-accent',
                )}
                data-side-chat-row={item().id}
                onClick={() => {
                  if (inFront()) return setFront(null)
                  setFront(item().id)
                  if (!mainShown()) void talkToUltimate({ switchConversation, showSurface })
                }}
                size={null}
                variant={null}
              >
                <GitForkIcon class="size-3 shrink-0 text-brand" />
                <span class="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground/80">
                  Side chat · {formatTime(item().openedAt)}
                </span>
                <span
                  class={cn(
                    'shrink-0 font-mono text-[10px]',
                    inFront() || working() ? 'text-brand' : 'text-muted-foreground',
                  )}
                >
                  {working() ? 'working' : inFront() ? 'in front' : 'open'}
                </span>
              </Button>
            )
          }}
        </For>
      </fieldset>
    </Show>
  )
}

function sideIds(main: () => ConversationId | undefined) {
  const index = useDocOf(main, SideChatsDoc)
  const questions = useDocOf(() => ROOT, QuestionSidesDoc)
  return createMemo(
    () =>
      new Set(
        [...(index()?.sides ?? []), ...(questions()?.sides ?? [])].map((side) => Number(side.id)),
      ),
  )
}

export default defineWebExtension({
  composer: ComposerFrame,
  slots: { 'conversation.overlay': [Stage] },
  entries: { 'sidechat.summary': SummaryCard },
  provides: [
    provide(UnderUltimate, SideRows),
    provide(Unlisted, sideIds),
    provide(CardActions, TalkItThrough),
    provide(QuestionPane, inboxSideChat),
    provide(EmptyTranscript, QuestionSideStart),
  ],
})
