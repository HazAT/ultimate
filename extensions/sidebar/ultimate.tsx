import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  cn,
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
  conversationState,
  emptyMessages,
  stateTone,
  stateWord,
  waitingOnUser,
} from '../messages/ui.tsx'
import { AgentMark, ConversationPhase, useOverview } from '../conversations/ui.tsx'
import { StandingDoc, talkToUltimate } from '../subagents/ui.tsx'

/** Renders with how many questions wait on the user's answer or dismissal. */
export function WaitingOnUser({ children }: { children: (waiting: number) => ReactNode }) {
  return children(waitingOnUser(useDocOf(1, MessagesDoc) ?? emptyMessages))
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
 * The title bar's way to @ultimate on phones, where the sidebar with its row is hidden: its state as its sidebar row
 * says it (`conversationState`), the mark pulsing while it works and amber while questions wait on you.
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
  const log = useDocOf(1, MessagesDoc) ?? emptyMessages
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
  const state = conversationState(
    { id: id ?? -1, kind: 'primary', runState, busy: working, parked: paused },
    log,
  )
  const waiting = waitingOnUser(log)
  const active = id !== undefined && shown === id && actions.surface === 'agent'
  return (
    <Provided input={working ? id : undefined} point={ConversationPhase}>
      {(phase) => {
        const word = workingWord(phase)
        const label = state === 'working' ? word : stateWord(state, waiting)
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
                data-ui="ultimate-button"
                data-ultimate-button
                onClick={() => void talkToUltimate(actions)}
                type="button"
              >
                <AgentMark
                  name={name}
                  presence={working ? 'working' : state === 'waits' ? 'waiting' : undefined}
                  size="sm"
                />
                @{name}
                {state === 'working' && word !== 'working' && (
                  <span className="text-brand">{word}</span>
                )}
                {/* The bare count: the phone bar has no room for its words, which the label carries. */}
                {(state === 'paused' || state === 'waits') && (
                  <span className={stateTone[state]}>{state === 'waits' ? waiting : 'paused'}</span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              Talk to @{name} · {label}
            </TooltipContent>
          </Tooltip>
        )
      }}
    </Provided>
  )
}
