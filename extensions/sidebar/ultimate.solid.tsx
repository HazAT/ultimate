/** @jsxImportSource @solidjs/web */
import { createMemo, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
import { useProvided } from '@/sdk/parts.solid.tsx'
import { cn, ParkedRuns, ROOT, useDocOf, useTasks } from '@/sdk/solid'
import { useAutomations, timerWaits } from '../automations/ui.solid.tsx'
import { OverviewDoc } from '../conversations/refs.ts'
import { AgentMark, ConversationPhase } from '../conversations/ui.solid.tsx'
import { MessagesDoc } from '../messages/refs.ts'
import {
  conversationState,
  conversationWait,
  emptyMessages,
  stateTone,
  stateWord,
  useUnderway,
  waitLabel,
  waitingOnUser,
} from '../messages/ui.solid.tsx'
import { StandingDoc } from '../subagents/refs.ts'
import { talkToUltimate } from '../subagents/ui.solid.tsx'
import { shell, useShownId, useSurface } from './state.solid.tsx'

export const workingWord = (phase?: { word: string; waiting: boolean }) =>
  phase && !phase.waiting ? phase.word : 'working'

export function UltimateWordmark() {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label="Talk to @ultimate"
        class="flex h-6 shrink-0 items-center gap-2 rounded-sm px-1.5 font-sans text-[11px] font-semibold tracking-[0.28em] text-brand transition-colors outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
        data-ui="wordmark"
        onClick={() => void talkToUltimate(shell)}
        render={(trigger) => <Button {...trigger} size={null} variant={null} />}
      >
        ULTIMATE
      </TooltipTrigger>
      <TooltipContent>Talk to @ultimate</TooltipContent>
    </Tooltip>
  )
}

export function UltimateButton() {
  const parked = useProvided(ParkedRuns, () => null)
  const standing = useDocOf(() => ROOT, StandingDoc)
  const id = () => standing()?.ultimate
  const list = useAutomations(() => 5000)
  const timers = createMemo(() => timerWaits(list().data, standing()))
  const tasks = useTasks()
  const messages = useDocOf(() => ROOT, MessagesDoc)
  const log = () => messages() ?? emptyMessages
  const overview = useDocOf(() => ROOT, OverviewDoc)
  const shown = useShownId()
  const surface = useSurface()
  const underway = useUnderway()
  const paused = () => id() !== undefined && parked()?.has(id()!) === true
  const runState = () => overview()?.conversations[id() ?? -1]?.runState
  const working = createMemo(
    () =>
      id() !== undefined &&
      !paused() &&
      (runState() === 'working' ||
        Object.values(tasks()?.tasks ?? {}).some(
          (task) => !task.background && task.conversationId === id(),
        )),
  )
  const facts = createMemo(() => ({
    id: id() ?? -1,
    kind: 'primary' as const,
    runState: runState(),
    busy: working() || (!paused() && underway(id() ?? -1)),
    parked: paused(),
  }))
  const state = createMemo(() => conversationState(facts(), log(), timers()))
  const waiting = createMemo(() => waitingOnUser(log()))
  const phase = useProvided(ConversationPhase, () => (working() ? id() : undefined))
  const word = () => workingWord(phase())
  const label = () =>
    state() === 'working'
      ? word()
      : stateWord(state(), waiting(), waitLabel(conversationWait(facts(), log(), timers()), id()))
  const active = () => id() !== undefined && shown() === id() && surface() === 'agent'
  return (
    <span class="contents md:hidden">
      <Tooltip>
        <TooltipTrigger
          aria-current={active() ? 'page' : undefined}
          aria-label={`Open @ultimate on mobile (${label()})`}
          class={cn(
            'flex h-5 shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-[11.5px] font-normal transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
            active() && 'text-foreground',
          )}
          data-ui="ultimate-button"
          data-ultimate-button="true"
          onClick={() => void talkToUltimate(shell)}
          render={(trigger) => <Button {...trigger} size={null} variant={null} />}
        >
          <AgentMark
            name="ultimate"
            presence={
              working()
                ? 'working'
                : state() === 'waits'
                  ? 'waiting'
                  : state() === 'awaiting'
                    ? 'awaiting'
                    : undefined
            }
            size="sm"
          />
          @ultimate
          <Show when={state() === 'working' && word() !== 'working'}>
            <span class="text-brand">{word()}</span>
          </Show>
          <Show when={state() === 'paused' || state() === 'waits'}>
            <span class={stateTone[state()]}>{state() === 'waits' ? waiting() : 'paused'}</span>
          </Show>
        </TooltipTrigger>
        <TooltipContent>Talk to @ultimate · {label()}</TooltipContent>
      </Tooltip>
    </span>
  )
}
