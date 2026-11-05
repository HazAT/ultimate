/**
 * The goal's two transcript cards in @ultimate's conversation: `goal.started`, live while it works (criteria, the latest
 * decisions, End), and `goal.report`, what happened while the user was away: every decision with its reason.
 */
import {
  CheckIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  BellIcon,
  BellOffIcon,
  FlagIcon,
  LoaderCircleIcon,
} from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { ToolImage } from '@/components/ai/tool'
import { Button } from '@/components/ui/button'
import {
  api,
  cn,
  errorMessage,
  formatDuration,
  formatTime,
  useAction,
  useDocOf,
  useUltimate,
} from '@/sdk'
import { plural } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { ConversationRef } from '../conversations/ui.tsx'
import { EndAction, GoalDoc, ImagesAction } from './refs.ts'
import type { Criterion, Decision, Goal, GoalEntry } from './refs.ts'

function useGoal(id: number) {
  return useDocOf(1, GoalDoc)?.goals.find((goal) => goal.id === id)
}

/** The frame both cards share: an accent rule on the left, a mono header row. */
function Card({
  goal,
  header,
  children,
}: {
  goal: number
  header: ReactNode
  children?: ReactNode
}) {
  return (
    <section
      className="min-w-0 rounded-md border border-border border-l-2 border-l-brand/50 bg-muted/20"
      data-goal={goal}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[0.6875rem] text-muted-foreground">
        {header}
      </header>
      {children}
    </section>
  )
}

const marks: Record<Criterion['status'], ReactNode> = {
  open: <CircleDashedIcon className="size-3.5 text-muted-foreground" />,
  met: <CheckIcon className="size-3.5 text-success" />,
  blocked: <CircleSlashIcon className="size-3.5 text-warning" />,
}

function Criteria({ goal }: { goal: Goal }) {
  if (!goal.criteria.length)
    return (
      <p className="px-4 py-2 text-[0.75rem] text-muted-foreground">
        Writing down what done means…
      </p>
    )
  return (
    <ol className="space-y-1 px-4 py-2.5" data-goal-criteria>
      {goal.criteria.map((item, index) => (
        <li
          className="flex items-start gap-2 text-[0.8125rem] leading-5"
          data-goal-criterion={item.status}
          // oxlint-disable-next-line react/no-array-index-key -- Criteria are numbered positions; text may repeat.
          key={index}
        >
          <span className="mt-0.5 shrink-0">{marks[item.status]}</span>
          <span className={cn('min-w-0', item.status === 'met' && 'text-muted-foreground')}>
            {item.text}
            {item.status !== 'met' && item.tries ? (
              <span className="ml-2 font-mono text-[0.6875rem] text-muted-foreground">
                {item.status === 'blocked' ? 'blocked after' : ''}{' '}
                {plural(item.tries, 'failed try')}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  )
}

function Screenshots({ goal, entry }: { goal: number; entry: number }) {
  const { data } = useAction(ImagesAction, { goal, entry })
  if (!data?.length) return null
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {data.map((image, index) => (
        <ToolImage
          alt={`Screenshot ${index + 1} @ultimate judged`}
          className="max-w-60"
          image={image}
          // oxlint-disable-next-line react/no-array-index-key -- Fixed screenshot attachments may contain duplicates.
          key={index}
        />
      ))}
    </div>
  )
}

function DecisionRow({ goal, decision }: { goal: number; decision: Decision }) {
  const { switchConversation } = useUltimate()
  return (
    <li className="space-y-0.5 py-2" data-goal-decision>
      <p className="flex flex-wrap items-baseline gap-x-2 font-mono text-[0.6875rem] text-muted-foreground">
        <span>{formatTime(decision.at)}</span>
        {decision.conversation !== undefined && (
          <button
            className="flex min-w-0 cursor-pointer items-center hover:text-foreground"
            onClick={() => switchConversation(decision.conversation!)}
            title="Open the conversation this decision was for"
            type="button"
          >
            <ConversationRef id={decision.conversation} />
          </button>
        )}
      </p>
      <p className="text-[0.8125rem] leading-5 text-muted-foreground">{decision.question}</p>
      <p className="text-[0.8125rem] leading-5">
        <span className="text-foreground">→ {decision.picked}</span>
        <span className="text-muted-foreground"> · {decision.reason}</span>
      </p>
      {decision.images !== undefined && <Screenshots entry={decision.images} goal={goal} />}
    </li>
  )
}

function Decisions({ goal, latest }: { goal: Goal; latest?: number }) {
  const shown = latest ? goal.decisions.slice(-latest) : goal.decisions
  if (!shown.length) return null
  return (
    <div className="border-t border-border/60 px-4 pt-1.5 pb-1">
      <h3 className="pt-1 section-label">
        {latest && goal.decisions.length > latest
          ? `Latest decisions · ${goal.decisions.length} in all`
          : `Decisions I took for you · ${goal.decisions.length}`}
      </h3>
      <ul className="divide-y divide-border/50">
        {shown.map((decision, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- Decisions have no id; timestamps may repeat.
          <DecisionRow decision={decision} goal={goal.id} key={index} />
        ))}
      </ul>
    </div>
  )
}

function Words({ goal }: { goal: Goal }) {
  return (
    <p className="px-4 pt-3 pb-1 text-[0.8125rem] leading-relaxed whitespace-pre-wrap text-foreground">
      {goal.text}
    </p>
  )
}

/** `goal.started`: the goal while @ultimate works on it, with End; once ended, a pointer to its report. */
export function StartedCard({ entry }: { entry: EntryRecord }) {
  const { goal: id } = entry.data as GoalEntry
  const goal = useGoal(id)
  const open = !!goal && !goal.ended
  return (
    <Card
      goal={id}
      header={
        <>
          <FlagIcon className="size-3.5 text-brand" />
          <span className="text-foreground">Hands-off goal {id}</span>
          {goal && (
            <span>
              {open
                ? `since ${formatTime(goal.startedAt)}`
                : `ended ${formatTime(goal.ended!.at)} · report below`}
            </span>
          )}
        </>
      }
    >
      {!goal ? (
        <p className="px-3 py-3 text-[0.75rem] text-muted-foreground">Loading…</p>
      ) : (
        <>
          <Words goal={goal} />
          {open && (
            <>
              <Criteria goal={goal} />
              <Decisions goal={goal} latest={3} />
              <Reminder goal={goal} />
              <Footer />
            </>
          )}
        </>
      )}
    </Card>
  )
}

/** The goal reminder's state: waking @ultimate every 30 minutes, or paused while it waits on the user. */
function Reminder({ goal }: { goal: Goal }) {
  if (!goal.reminder && !goal.waiting) return null
  return (
    <p
      className="flex items-start gap-2 border-t border-border/60 px-4 py-2 text-[0.75rem] leading-snug"
      data-goal-reminder={goal.waiting ? 'paused' : 'active'}
    >
      {goal.waiting ? (
        <>
          <BellOffIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span className="min-w-0">
            <span className="text-warning">Waiting on you:</span> {goal.waiting.reason}
            <span className="ml-2 font-mono text-[0.6875rem] text-muted-foreground">
              reminder paused since {formatTime(goal.waiting.at)}
            </span>
          </span>
        </>
      ) : (
        <>
          <BellIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">
            A reminder wakes me every 30 minutes to check nothing is stuck.
          </span>
        </>
      )}
    </p>
  )
}

function Footer() {
  const [ending, setEnding] = useState(false)
  const [failure, setFailure] = useState<string>()
  const endGoal = async () => {
    setEnding(true)
    setFailure(undefined)
    try {
      await api.action(EndAction, null)
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setEnding(false)
    }
  }
  return (
    <footer className="flex flex-wrap items-center gap-3 border-t border-border/60 px-4 py-2.5">
      <span className="min-w-0 flex-1 text-[0.75rem] leading-snug text-muted-foreground">
        I decide what I would ask you and note each decision here. Pause stops everything at once.
      </span>
      {failure && <p className="w-full text-[0.75rem] text-error">{failure}</p>}
      <Button
        data-goal-end
        disabled={ending}
        onClick={() => void endGoal()}
        size="sm"
        variant="outline"
      >
        {ending && <LoaderCircleIcon className="motion-safe:animate-spin" />}
        End hands-off
      </Button>
    </footer>
  )
}

const headlines = {
  met: 'Goal met',
  blocked: 'Stuck: every remaining criterion is blocked',
  ended: 'You ended it',
}

/** `goal.report`: how the goal ended, its criteria, and every decision @ultimate took for the user. */
export function ReportCard({ entry }: { entry: EntryRecord }) {
  const { goal: id } = entry.data as GoalEntry
  const goal = useGoal(id)
  const ended = goal?.ended
  return (
    <Card
      goal={id}
      header={
        <>
          <FlagIcon className="size-3.5 text-brand" />
          <span className="text-foreground">Hands-off report</span>
          <span>goal {id}</span>
          {goal && ended && <span>{formatDuration(ended.at - goal.startedAt)}</span>}
        </>
      }
    >
      {!goal || !ended ? (
        <p className="px-3 py-3 text-[0.75rem] text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="space-y-1 px-4 pt-3" data-goal-outcome={ended.outcome}>
            <p
              className={cn(
                'text-[0.8125rem]',
                ended.outcome === 'met'
                  ? 'text-success'
                  : ended.outcome === 'blocked'
                    ? 'text-warning'
                    : 'text-foreground',
              )}
            >
              {headlines[ended.outcome]}
            </p>
            <p className="font-mono text-[0.6875rem] text-muted-foreground">
              {formatTime(goal.startedAt)}–{formatTime(ended.at)} ·{' '}
              {goal.criteria.length > 0 &&
                `${goal.criteria.filter((item) => item.status === 'met').length} of ${goal.criteria.length} criteria met · `}
              {plural(goal.decisions.length, 'decision')}
            </p>
          </div>
          {ended.summary && (
            <p className="px-4 pt-2 text-[0.8125rem] leading-relaxed whitespace-pre-wrap">
              {ended.summary}
            </p>
          )}
          <Words goal={goal} />
          {goal.criteria.length > 0 && <Criteria goal={goal} />}
          <Decisions goal={goal} />
        </>
      )}
    </Card>
  )
}
