import type { ConversationId } from '@earendil-works/pi-durable'
import { ROOT, renderEntry } from '@/sdk'
import { deadline } from '../../lib/timers.ts'
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  GitForkIcon,
  LoaderCircleIcon,
  MessageCircleQuestionIcon,
  MinimizeIcon,
  SparklesIcon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import {
  api,
  Card,
  cn,
  column,
  ComposerRedirect,
  Conversation,
  ConversationScope,
  defineWebExtension,
  EmptyTranscript,
  errorMessage,
  formatTime,
  provide,
  useConversation,
  useConversations,
  useDoc,
  useDocOf,
  useUiState,
  useUltimate,
  useViewport,
} from '@/sdk'
import type { ComposerTarget } from '@/sdk'
import { StandingDoc, talkToUltimate } from '../subagents/ui.tsx'
import { UnderUltimate, Unlisted } from '../sidebar/ui.tsx'
import { MessagesDoc } from '../messages/ui.tsx'
import {
  answered,
  CardActions,
  cardKey,
  cardOf,
  CARDS_KEY,
  MessageQuestions,
} from '../questions/ui.tsx'
import type { CardState, QuestionMessage } from '../questions/ui.tsx'
import { QuestionPane } from '../inbox/ui.tsx'
import {
  contextSize,
  createEndings,
  endings,
  frontSide,
  openQuestionSide,
  openSides,
  togglesSideMode,
} from './logic.ts'
import {
  DiscardAction,
  InjectAction,
  OpenAction,
  QuestionSidesDoc,
  SideChatDoc,
  SideChatsDoc,
} from './refs.ts'
import { SideChatSummaryEntry } from './entries.ts'
import type { SideChatIndex } from './refs.ts'
import type { Reply } from '../questions/refs.ts'
import { useSideChatFront as useFront } from './ui.tsx'

let forkOnEnterInThisTab = false
const listeners = new Set<() => void>()
const setSide = (value: boolean) => {
  forkOnEnterInThisTab = value
  for (const listener of listeners) listener()
}
const useSideMode = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    () => forkOnEnterInThisTab,
  )

const sideEndings = createEndings(errorMessage)

function useMain() {
  const main = useDocOf(ROOT, StandingDoc)?.ultimate
  const index = useDocOf(main, SideChatsDoc) ?? undefined
  return { main, index }
}

function useShownIndex() {
  const id = useConversation((conversation) => conversation.id)
  return { id, index: useDocOf(id, SideChatsDoc) ?? undefined }
}

const ease = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
const sheetTransitionMs = 420
const unmountAfterExitPaddingMs = 60
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

function ModeSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      aria-label={`Composer sends to ${on ? 'a new side chat' : '@ultimate'} · Tab switches`}
      aria-pressed={on}
      data-ui="side-chat-switch"
      className="relative flex h-5 cursor-pointer items-center rounded-full bg-muted/60 p-0.5 font-mono text-[10.5px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onClick={onToggle}
      type="button"
    >
      <span
        aria-hidden
        className={cn(
          'absolute top-0.5 bottom-0.5 left-0.5 w-[4.75rem] rounded-full bg-background shadow-xs transition-transform duration-300 motion-reduce:transition-none',
          on && 'translate-x-[4.75rem] ring-1 ring-brand/40',
        )}
        style={{ transitionTimingFunction: ease }}
      />
      <span
        className={cn(
          'relative z-10 w-[4.75rem] text-center whitespace-nowrap transition-colors',
          on ? 'text-muted-foreground/70' : 'text-foreground',
        )}
      >
        Normal
      </span>
      <span
        className={cn(
          'relative z-10 flex w-[4.75rem] items-center justify-center gap-1 whitespace-nowrap transition-colors',
          on ? 'text-brand' : 'text-muted-foreground/70',
        )}
      >
        <GitForkIcon className="size-2.5" />
        Side chat
      </span>
    </button>
  )
}

function StableComposerFrame({ core, dock }: { core: ReactNode; dock?: boolean }) {
  const { id, index } = useShownIndex()
  const { main } = useMain()
  const active = id !== undefined && id === main && !dock
  const hasSides = !dock && openSides(index).length > 0
  const on = useSideMode() && active
  const [front, setFront] = useFront()
  const sideCoveringMainComposer = !dock ? frontSide(front, index) : undefined
  const parked = (dock ? [] : openSides(index)).filter(
    (item) => item.id !== sideCoveringMainComposer?.id,
  )
  const target: ComposerTarget | undefined = on
    ? {
        placeholder: 'Ask on the side — @ultimate keeps running…',
        send: async (text) => {
          const opened = await api.action(OpenAction, { text }, { conversationId: main })
          setSide(false)
          setFront(opened.id)
        },
      }
    : undefined
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!active || !(event.target instanceof HTMLTextAreaElement)) return
    const popup = event.target.getAttribute('aria-expanded') === 'true'
    const key = { ...event, isComposing: event.nativeEvent.isComposing }
    if (!togglesSideMode(key, { conversation: id, ultimate: main, popup })) return
    event.preventDefault()
    setSide(!on)
  }
  return (
    <div
      className="relative"
      data-side-mode={active ? (on ? 'side' : 'normal') : undefined}
      onKeyDownCapture={onKeyDown}
    >
      <div data-main-composer={active || undefined} inert={!!sideCoveringMainComposer}>
        <div
          className={cn(column(), 'flex items-center justify-between gap-2 pb-1.5')}
          hidden={!active && !(hasSides && parked.length)}
        >
          <div
            className="flex min-w-0 items-center gap-3 font-mono text-[11px] text-muted-foreground/70"
            data-ui="side-chat-hint"
          >
            {parked.map((item) => (
              <button
                className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground hover:text-foreground"
                key={item.id}
                onClick={() => setFront(item.id)}
                title="Bring this side chat back to the front"
                type="button"
              >
                <GitForkIcon className="size-3 text-brand" />
                {item.question === undefined ? 'Side chat' : 'Question side chat'} ·{' '}
                {formatTime(item.openedAt)}
                <span className="text-brand">show</span>
              </button>
            ))}
            {active && parked.length === 0 && (
              <span className="truncate pointer-coarse:hidden">
                {on ? (
                  <>
                    <span className="text-brand">↵</span> forks @ultimate · <Kbd>Tab</Kbd> back to
                    normal
                  </>
                ) : (
                  <>
                    <Kbd>Tab</Kbd> side chat
                  </>
                )}
              </span>
            )}
          </div>
          {active && <ModeSwitch on={on} onToggle={() => setSide(!on)} />}
        </div>
        <div
          className={cn(
            'relative transition-[padding] duration-300 motion-reduce:transition-none',
            on ? 'sm:pl-6' : 'pl-0',
            '[&_form]:transition-[border-color] [&_form]:duration-300',
            on &&
              '[&_form]:border-dashed [&_form]:border-brand/60 [&_form]:focus-within:border-brand/80',
          )}
          style={{ transitionTimingFunction: ease }}
        >
          <ComposerRedirect to={target}>{core}</ComposerRedirect>
        </div>
      </div>
      {sideCoveringMainComposer && <MainBlocked onBack={() => setFront(null)} />}
    </div>
  )
}

function MainBlocked({ onBack }: { onBack: () => void }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center bg-background/70 backdrop-blur-[1px]">
      <div className={column()}>
        <div className="flex w-fit items-center gap-3 rounded-lg border border-border bg-card px-3.5 py-2 font-mono text-[11.5px] text-muted-foreground shadow-sm">
          <GitForkIcon className="size-3.5 text-brand" />
          <span>Typing goes to the side chat</span>
          <button
            className="flex cursor-pointer items-center gap-1 rounded-sm px-1.5 py-0.5 text-foreground hover:bg-accent"
            onClick={onBack}
            type="button"
          >
            <ArrowLeftIcon className="size-3" />
            Back to main
          </button>
        </div>
      </div>
    </div>
  )
}

function Stage() {
  const { id, index } = useShownIndex()
  const [front, setFront] = useFront()
  const phone = useViewport() === 'phone'
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const isMain = id !== undefined && openSides(index).length > 0
  const current = isMain ? frontSide(front, index) : undefined
  const [mountedThroughExit, setShown] = useState<ConversationId>()
  if (current && mountedThroughExit !== current.id) setShown(current.id)
  useEffect(() => {
    if (current) return undefined
    return deadline(sheetTransitionMs + unmountAfterExitPaddingMs, () => setShown(undefined))
  }, [current])

  useLayoutEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent) return undefined
    const observer = new ResizeObserver(() => setWidth(parent.clientWidth))
    observer.observe(parent)
    return () => observer.disconnect()
  }, [isMain])

  const inFront = current !== undefined
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent) return undefined
    const layers = [...parent.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement && !child.contains(ref.current),
    )
    const still = reduced()
    const reading = layers
      .map((layer) => layer.querySelector<HTMLElement>('[data-ui="transcript"]'))
      .find(Boolean)
    const userConfiguredReadingWidth = reading?.offsetWidth ?? width
    const scale = phone ? 0.92 : 0.88
    const restBesideSheetX = phone
      ? 0
      : Math.min(0, 24 - (width / 2 - (userConfiguredReadingWidth / 2) * scale))
    for (const layer of layers) {
      layer.style.transition = still
        ? `opacity ${sheetTransitionMs}ms ease`
        : `transform ${sheetTransitionMs}ms ${ease}, opacity ${sheetTransitionMs}ms ease, filter ${sheetTransitionMs}ms ease`
      layer.style.transformOrigin = `50% ${(phone ? 0 : parent.clientHeight / 2) - layer.offsetTop}px`
      layer.style.transform =
        inFront && !still
          ? phone
            ? `translateY(10px) scale(${scale})`
            : `translateX(${restBesideSheetX}px) scale(${scale})`
          : ''
      layer.style.opacity = inFront ? (phone ? '0.45' : still ? '0.5' : '0.62') : ''
      layer.style.filter = inFront ? 'saturate(0.7)' : ''
      layer.toggleAttribute('data-receded', inFront)
      const transcriptLayer = !!layer.querySelector('[data-ui="transcript"]')
      if (transcriptLayer) layer.inert = inFront
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
  }, [inFront, width, phone])

  if (!isMain) return null
  const still = reduced()
  const away = phone ? 'translateY(105%)' : 'translateX(14%) scale(0.96)'
  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden" ref={ref}>
      {inFront && phone && (
        <button
          className="pointer-events-auto absolute inset-x-0 top-0 flex h-11 cursor-pointer items-center justify-center gap-2 bg-gradient-to-b from-background via-background/90 to-background/40 font-mono text-[11px] text-muted-foreground"
          onClick={() => setFront(null)}
          type="button"
        >
          <span className="size-1.5 rounded-full bg-brand motion-safe:animate-pulse" />
          {current?.question === undefined ? '@ultimate keeps working' : `#${id} waits`} ·{' '}
          <span className="text-foreground">show main</span>
        </button>
      )}
      {mountedThroughExit !== undefined && (
        <section
          aria-label="Side chat"
          className={cn(
            'absolute flex flex-col overflow-hidden border border-border bg-background shadow-2xl shadow-black/40',
            inFront && 'pointer-events-auto',
            phone
              ? 'inset-x-0 top-11 bottom-0 rounded-t-2xl border-b-0'
              : 'top-3 right-5 bottom-3 rounded-xl',
          )}
          data-side-chat={mountedThroughExit}
          inert={!inFront}
          style={{
            width: phone ? undefined : `min(44rem, ${Math.round(width * 0.6)}px)`,
            transition: still
              ? `opacity ${sheetTransitionMs}ms ease`
              : `transform ${sheetTransitionMs}ms ${ease}, opacity ${sheetTransitionMs}ms ease`,
            transform: inFront || still ? 'none' : away,
            opacity: inFront ? 1 : 0,
          }}
        >
          <ConversationScope id={mountedThroughExit}>
            <SidePane
              front={inFront}
              index={index}
              onPark={() => setFront(null)}
              phone={phone}
              side={mountedThroughExit}
            />
          </ConversationScope>
        </section>
      )}
    </div>
  )
}

function SidePane({
  side,
  index,
  front,
  phone,
  onPark,
}: {
  side: ConversationId
  index?: SideChatIndex
  front: boolean
  phone: boolean
  onPark: () => void
}) {
  const state = useDoc(SideChatDoc) ?? undefined
  const busy = useConversation((conversation) => conversation.busy)
  const can = endings(state)
  const { ending, error } = useSyncExternalStore(sideEndings.subscribe, () => sideEndings.get(side))
  const openedAt = index?.sides.find((item) => item.id === side)?.openedAt
  useEffect(() => {
    if (front) document.getElementById(`composer-input-${side}`)?.focus()
  }, [front, side])
  const end = (how: 'discard' | 'inject') =>
    sideEndings.end(side, how, () =>
      api.action(how === 'inject' ? InjectAction : DiscardAction, { id: side }),
    )
  const question = state?.question
  const asker = state?.of
  return (
    <>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <GitForkIcon className="size-3.5 text-brand" />
        <span className="text-[13px] font-semibold">Side chat</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {question === undefined
            ? 'temporary copy of @ultimate'
            : `read-only copy of #${asker}${state?.tokens ? ` · ${contextSize(state.tokens)} context` : ''}`}
        </span>
        <button
          aria-label={`Back to ${question === undefined ? 'main' : 'the question'}, keep the side chat`}
          className="ml-auto flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          onClick={onPark}
          title={`Back to ${question === undefined ? 'main' : 'the question'} · keeps the side chat`}
          type="button"
        >
          <MinimizeIcon className="size-3.5" />
        </button>
      </header>
      {openedAt !== undefined && (
        <Cut at={openedAt} from={question === undefined ? '@ultimate' : `#${asker}`} />
      )}
      {question !== undefined && (
        <PinnedQuestion
          answerWith={(answer, keepalive) =>
            api
              .action(InjectAction, { id: side, answer }, { keepalive })
              .catch((failure: unknown) => {
                throw new Error(
                  `Nothing was sent: ${errorMessage(failure).replace(/^side-chat\/\w+: /, '')}`,
                )
              })
          }
          keys={front && !phone}
          message={question}
        />
      )}
      <Conversation variant={phone ? 'dock' : 'main'} />
      <footer
        className={cn('shrink-0 border-t border-border/60 py-2', phone ? 'px-3' : 'px-5')}
        data-side-chat-actions
      >
        {error && (
          <p className="pb-2 font-mono text-[11px] break-words text-error" role="alert">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          <span className="mr-auto min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            {can.locked
              ? 'This side chat changed things · summarize to keep main informed'
              : phone
                ? 'End it with'
                : question === undefined
                  ? 'Main keeps running · end it with'
                  : `#${asker} waits for your answer · end it with`}
          </span>
          {can.discard && (
            <Button
              className="text-muted-foreground"
              disabled={ending !== undefined}
              onClick={() => void end('discard')}
              size="sm"
              title={
                question === undefined
                  ? 'Throw it away; main never hears of it'
                  : `Throw it away; #${asker} never hears of it`
              }
              variant="ghost"
            >
              {ending === 'discard' ? (
                <LoaderCircleIcon className="motion-safe:animate-spin" />
              ) : (
                <Trash2Icon />
              )}
              Discard
            </Button>
          )}
          <Button
            className="border-brand/50 text-foreground hover:border-brand"
            disabled={!can.inject || ending !== undefined}
            onClick={() => void end('inject')}
            size="sm"
            title={
              question !== undefined
                ? `Send #${asker} a summary without answering yet; answer on the card to send both`
                : busy
                  ? 'Stops the side chat, then sends main a summary'
                  : 'Send main a summary it reads with its next input'
            }
            variant="outline"
          >
            {ending === 'inject' ? (
              <LoaderCircleIcon className="text-brand motion-safe:animate-spin" />
            ) : (
              <SparklesIcon className="text-brand" />
            )}
            {ending === 'inject'
              ? 'Summarizing…'
              : error
                ? 'Retry summary'
                : question === undefined
                  ? 'Summarize & inject'
                  : 'Summarize only'}
          </Button>
        </div>
      </footer>
    </>
  )
}

function PinnedQuestion({
  message: id,
  keys,
  answerWith,
}: {
  message: number
  keys: boolean
  answerWith: (answer: Reply, keepalive?: boolean) => Promise<unknown>
}) {
  const message = useDocOf(ROOT, MessagesDoc)?.messages.find((item) => item.id === id)
  const [cards] = useUiState<Record<string, CardState>>(CARDS_KEY, {})
  const [folded, setFolded] = useState(true)
  if (!message) return null
  const questions = message.questions ?? []
  const ready = answered(questions, cardOf(cards, cardKey(id), questions).drafts).length
  const waits = message.state === 'delivered'
  const settled =
    message.state === 'dismissed'
      ? 'dismissed · the asker knows'
      : 'answered · the asker has your answer'
  const lead = message.text.split('\n').find((line) => line.trim()) ?? ''
  return (
    <section
      aria-label="The question"
      className="mx-3 mt-2 flex max-h-[45%] shrink-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-card/60"
      data-pinned-question={id}
    >
      <button
        aria-expanded={!folded}
        className="flex w-full shrink-0 cursor-pointer items-center gap-2 px-3 py-1.5 text-left font-mono text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => setFolded(!folded)}
        type="button"
      >
        <MessageCircleQuestionIcon className="size-3.5 shrink-0 text-brand" />
        <span className="min-w-0 flex-1 truncate">
          {waits ? lead.replace(/\*\*/g, '') : settled}
        </span>
        {waits && folded && (
          <span className="shrink-0 text-brand">
            {questions.length
              ? `${ready}/${questions.length} · ${ready ? 'review & send' : 'answer'}`
              : 'answer'}
          </span>
        )}
        <ChevronDownIcon
          className={cn('size-3.5 shrink-0 transition-transform', folded && '-rotate-90')}
        />
      </button>
      {!folded && waits && (
        <div className="min-h-0 overflow-y-auto">
          <MessageQuestions
            answerWith={answerWith}
            keys={keys}
            message={message}
            sendLabel="Summarize & send"
            withActions={false}
          />
        </div>
      )}
    </section>
  )
}

function useTalkItThrough(message: QuestionMessage): ReactNode {
  const sides = useDocOf(ROOT, QuestionSidesDoc)?.sides
  const [, setFront] = useFront()
  const [opening, setOpening] = useState(false)
  const { surface, conversationId, switchConversation } = useUltimate()
  const showAsker = (asker: ConversationId) => {
    if (surface === 'agent' && conversationId !== asker) switchConversation(asker)
  }
  const open = openQuestionSide(sides, message.id)
  if (typeof message.from !== 'number') return null
  const asking = message.from as ConversationId
  return (
    <Button
      className="text-muted-foreground"
      type="button"
      data-talk-it-through={message.id}
      disabled={opening}
      onClick={async () => {
        setOpening(true)
        try {
          const { id } = await api.action(OpenAction, { message: message.id })
          setFront(id)
          showAsker(asking)
        } finally {
          setOpening(false)
        }
      }}
      size="sm"
      title={
        open
          ? 'Back to the side chat where you are talking this question through'
          : 'Talk this question through in a read-only side chat forked from the agent that asked it'
      }
      variant="ghost"
    >
      {opening ? (
        <LoaderCircleIcon className="motion-safe:animate-spin" />
      ) : (
        <GitForkIcon className="text-brand" />
      )}
      Talk it through
    </Button>
  )
}

function useInboxSideChat({
  phone,
}: {
  message: QuestionMessage | undefined
  phone: boolean
}): ReactNode | undefined {
  const sides = useDocOf(ROOT, QuestionSidesDoc)?.sides
  const [front, setFront] = useFront()
  const side = sides?.find((item) => item.id === front && item.ended === undefined)
  const index = useDocOf(side?.of, SideChatsDoc) ?? undefined
  if (!side) return undefined
  return (
    <section
      aria-label="Side chat"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      data-side-chat={side.id}
    >
      <ConversationScope id={side.id}>
        <SidePane front index={index} onPark={() => setFront(null)} phone={phone} side={side.id} />
      </ConversationScope>
    </section>
  )
}

function useQuestionSideStart({
  conversation,
  core,
}: {
  conversation: ConversationId
  core: ReactNode
}): ReactNode {
  const side = useDocOf(conversation, SideChatDoc) ?? undefined
  const message = useDocOf(ROOT, MessagesDoc)?.messages.find((item) => item.id === side?.question)
  const asker = useConversations().find((item) => item.id === side?.of)
  if (side?.question === undefined || !message) return core
  return (
    <div className="mx-auto w-full max-w-2xl px-5 pt-14 pb-2" data-question-side-start>
      <p className="font-mono text-[11px] text-muted-foreground">
        #{side.of}
        {asker?.title ? ` · ${asker.title}` : ''} asked you, and knows everything that led here:
      </p>
      <div className="mt-2 border-l-2 border-brand/50 pl-3 text-[13px] leading-relaxed text-muted-foreground [&_p]:my-1">
        <MessageResponse>{message.text}</MessageResponse>
      </div>
      <p className="mt-3 font-mono text-[11px] text-muted-foreground/70">
        Ask why, what an option means, or say what to pick.
      </p>
    </div>
  )
}

function Cut({ at, from }: { at: number; from: string }) {
  return (
    <div
      className="flex shrink-0 items-center gap-3 px-5 pt-3 font-mono text-[11px] text-muted-foreground"
      role="separator"
    >
      <span className="h-px flex-1 border-t border-dashed border-border" />
      <span className="flex shrink-0 items-center gap-1.5">
        <GitForkIcon className="size-3 text-brand" />
        forked from {from} at {formatTime(at)}
        <span className="max-sm:hidden">· knows everything up to here</span>
      </span>
      <span className="h-px flex-1 border-t border-dashed border-border" />
    </div>
  )
}

const SummaryCard = renderEntry(SideChatSummaryEntry, function SummaryCard({ entry }) {
  const data = entry.data
  const { switchConversation } = useUltimate()
  const index = useDocOf(data.to, SideChatsDoc)
  const openedAt = index?.sides.find((item) => item.id === data.side)?.openedAt
  const at = entry.model?.[0]?.timestamp
  return (
    <Card data-side-chat-summary={data.side}>
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <GitForkIcon className="size-3.5 text-brand" />
        <span className="text-foreground">Side chat</span>
        <span>summary</span>
        {openedAt !== undefined && at !== undefined && (
          <span>
            {formatTime(openedAt)}–{formatTime(at)}
          </span>
        )}
        <button
          className="ml-auto flex cursor-pointer items-center gap-1 hover:text-foreground"
          onClick={() => switchConversation(data.side)}
          title={`Read side chat #${data.side}`}
          type="button"
        >
          <SquareArrowOutUpRightIcon className="size-3" />
          side chat
        </button>
      </header>
      <div className="min-w-0 px-3 py-3 font-sans text-[13px] leading-relaxed">
        <MessageResponse>{data.text}</MessageResponse>
      </div>
    </Card>
  )
})

function useSideRows(main: ConversationId | undefined): ReactNode {
  const index = useDocOf(main, SideChatsDoc) ?? undefined
  const [front, setFront] = useFront()
  const actions = useUltimate()
  const conversations = useConversations()
  const sides = openSides(index)
  if (main === undefined || sides.length === 0) return null
  return (
    <div aria-label="Side chats" className="flex flex-col gap-px" role="group">
      {sides.map((item) => {
        const mainShown = actions.surface === 'agent' && actions.conversationId === main
        const inFront = item.id === front && mainShown
        const working = conversations.find((conversation) => conversation.id === item.id)?.busy
        return (
          <button
            aria-current={inFront ? 'true' : undefined}
            className={cn(
              'mx-2 flex w-[calc(100%-1rem)] cursor-pointer items-center gap-1.5 rounded-md py-1.5 pr-2 pl-9 text-left outline-none hover:bg-sidebar-accent/50 focus-visible:ring-1 focus-visible:ring-ring',
              inFront && 'bg-sidebar-accent',
            )}
            data-side-chat-row={item.id}
            key={item.id}
            onClick={() => {
              if (inFront) return setFront(null)
              setFront(item.id)
              if (!mainShown) void talkToUltimate(actions)
            }}
            type="button"
          >
            <GitForkIcon className="size-3 shrink-0 text-brand" />
            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground/80">
              Side chat · {formatTime(item.openedAt)}
            </span>
            <span
              className={cn(
                'shrink-0 font-mono text-[10px]',
                inFront || working ? 'text-brand' : 'text-muted-foreground',
              )}
            >
              {working ? 'working' : inFront ? 'in front' : 'open'}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function useSideIds(main: ConversationId | undefined): ReadonlySet<number> {
  const sides = (useDocOf(main, SideChatsDoc) ?? undefined)?.sides
  const questionSides = useDocOf(ROOT, QuestionSidesDoc)?.sides
  return useMemo(
    () => new Set([...(sides ?? []), ...(questionSides ?? [])].map((side) => Number(side.id))),
    [sides, questionSides],
  )
}

export default defineWebExtension({
  composer: StableComposerFrame,
  slots: { 'conversation.overlay': [Stage] },
  entries: { 'sidechat.summary': SummaryCard },
  provides: [
    provide(UnderUltimate, useSideRows),
    provide(Unlisted, useSideIds),
    provide(CardActions, useTalkItThrough),
    provide(QuestionPane, useInboxSideChat),
    provide(EmptyTranscript, useQuestionSideStart),
  ],
})
