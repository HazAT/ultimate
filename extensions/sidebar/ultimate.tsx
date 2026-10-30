import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  cn,
  events,
  ParkedRuns,
  Provided,
  useDocOf,
  useStore,
  useTasks,
  useUltimate,
  Wordmark,
} from '@/sdk'
import {
  MessagesDoc,
  emptyMessages,
  nextWaiting,
  stateTone,
  stateWord,
  waitingOnUser,
} from '../messages/ui.tsx'
import type { MessagesData } from '../messages/refs.ts'
import { AgentMark, ConversationPhase, useOverview } from '../conversations/ui.tsx'
import { StandingDoc, talkToUltimate } from '../subagents/ui.tsx'
import { primaryLabel } from './label.ts'

/** Renders with how many questions wait on the user's answer or dismissal. */
export function WaitingOnUser({ children }: { children: (waiting: number) => ReactNode }) {
  return children(waitingOnUser(useDocOf(1, MessagesDoc) ?? emptyMessages))
}

/** Shared by the sidebars on Agent and Memory: changing surfaces remounts the row, not its cycle. */
let lastWaiting: number | undefined

/**
 * @ultimate's `N waiting on you`: each click opens the next open question at its message, oldest first, then wraps, as
 * the To-dos panel's question rows do.
 */
export function WaitingCount({ log, waiting }: { log: MessagesData; waiting: number }) {
  const { showSurface, switchConversation } = useUltimate()
  const open = () => {
    const message = nextWaiting(log, lastWaiting)
    if (!message) return
    lastWaiting = message.id
    if (message.call)
      events.emit('messages:open', { conversation: message.from, call: message.call })
    showSurface('agent')
    switchConversation(message.from)
  }
  return (
    <button
      className={cn(
        '-mx-1 -my-1 shrink-0 cursor-pointer rounded-sm px-1 py-1 underline-offset-2 outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ring',
        stateTone.waits,
      )}
      data-waiting-count
      onClick={open}
      title="Show the next question waiting on you"
      type="button"
    >
      {stateWord('waits', waiting)}
    </button>
  )
}

/** A busy standing agent's word: its classified phase, lower case like its idle line, else "working". */
const workingWord = (phase: { word: string; waiting: boolean } | undefined) =>
  phase && !phase.waiting ? phase.word : 'working'

/** A busy standing agent's line in the sidebar: its working word in the brand colour. */
export function StandingPhase({ id }: { id: number }) {
  return (
    <Provided input={id} point={ConversationPhase}>
      {(phase) => <span className="shrink-0 text-brand">{workingWord(phase)}</span>}
    </Provided>
  )
}

/** The title bar's wordmark beyond a phone opens @ultimate, as its sidebar row does. */
export function UltimateWordmark() {
  const actions = useUltimate()
  return <Wordmark label="Talk to @ultimate" onClick={() => void talkToUltimate(actions)} />
}

/**
 * The title bar's way to @ultimate on phones, where the sidebar with its row is hidden: its state, the mark amber while
 * questions wait on you.
 */
export function UltimateButton() {
  return (
    <span className="contents md:hidden">
      <Provided input={null} point={ParkedRuns}>
        {(parked) => <Primary parked={parked} />}
      </Provided>
    </span>
  )
}

const name = 'ultimate'

function Primary({ parked }: { parked?: ReadonlySet<number> }) {
  const actions = useUltimate()
  const id = useDocOf(1, StandingDoc)?.[name]
  const tasks = useTasks()
  const runState = useOverview()[id ?? -1]?.runState
  const shown = useStore((state) => state.view?.conversation.id ?? state.requested)
  const paused = id !== undefined && parked?.has(id) === true
  const working =
    id !== undefined &&
    !paused &&
    (runState === 'working' ||
      Object.values(tasks?.tasks ?? {}).some(
        (task) => !task.background && task.conversationId === id,
      ))
  const active = id !== undefined && shown === id && actions.surface === 'agent'
  return (
    <WaitingOnUser>
      {(waiting) => (
        <Provided input={working ? id : undefined} point={ConversationPhase}>
          {(phase) => {
            const word = workingWord(phase)
            const label = primaryLabel({ paused, working, word, waiting })
            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-current={active ? 'page' : undefined}
                    aria-label={`Talk to @${name} (${label})`}
                    className={cn(
                      'flex h-5 shrink-0 items-center gap-1.5 rounded-sm px-1.5 transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
                      active && 'text-foreground',
                    )}
                    data-ultimate-button
                    onClick={() => void talkToUltimate(actions)}
                    type="button"
                  >
                    <AgentMark
                      name={name}
                      presence={working ? 'working' : waiting ? 'waiting' : undefined}
                      size="sm"
                    />
                    @{name}
                    {working && word !== 'working' && <span className="text-brand">{word}</span>}
                    {paused && <span className="text-warning">paused</span>}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  Talk to @{name} · {label}
                </TooltipContent>
              </Tooltip>
            )
          }}
        </Provided>
      )}
    </WaitingOnUser>
  )
}
