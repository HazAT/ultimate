import { ChevronRightIcon, MoonIcon, MoonStarIcon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { api, Card as Frame, cn, formatTime, useDocOf, useUltimate } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { ConversationRef } from '../conversations/ui.tsx'
import { MoonRow, Passes, passLabels } from './moon.tsx'
import { FallAsleep } from './sleep.tsx'
import { sleepLeads } from './types.ts'
import { DreamDoc, EndAction } from './refs.ts'
import type { Handoff, HandoffEntry, Proposal, Session, SessionEntry } from './refs.ts'

/** Session `id` of the live `dream.sessions` document; undefined while it streams or when unknown. */
function useSession(id: number) {
  return useDocOf(1, DreamDoc)?.sessions.find((item) => item.id === id)
}

/** The card frame every dream entry shares: a night-accented rule on the left, a mono header row. */
function Card({
  session,
  header,
  children,
  className,
}: {
  session: number
  header: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <Frame className={className} data-dream-session={session}>
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        {header}
      </header>
      {children}
    </Frame>
  )
}

/** `dream.started`: the session began, and its passes as moons until the journal is filed. */
export function StartedCard({ entry }: { entry: EntryRecord }) {
  const { session: id } = entry.data as SessionEntry
  const session = useSession(id)
  const { switchConversation } = useUltimate()
  const filed = !!session?.journal
  return (
    <Card
      header={
        <>
          <MoonIcon className="size-3.5 text-brand" />
          <span className="text-foreground">Dream session {id}</span>
          <span>{session ? `started ${formatTime(session.startedAt)}` : 'started'}</span>
          {session && filed && <MoonRow session={session} />}
          {session?.dreamer !== undefined && (
            <button
              className="ml-auto flex min-w-0 cursor-pointer items-center hover:text-foreground"
              onClick={() => switchConversation(session.dreamer!)}
              title="Open the dream branch"
              type="button"
            >
              <ConversationRef id={session.dreamer} />
            </button>
          )}
        </>
      }
      session={id}
    >
      {session?.beforeCompaction && (
        <p
          className="border-b border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground"
          data-dream-before-compaction={session.beforeCompaction.automation}
        >
          {session.beforeCompaction.pause !== undefined
            ? `Started while you were away ${awayFor(session.beforeCompaction.pause)}`
            : 'Started as my context filled up'}{' '}
          · automation {session.beforeCompaction.automation}
        </p>
      )}
      {session?.handoff && <HandoffNote handoff={session.handoff} />}
      {session && !filed && (
        <>
          <div className="px-3 py-2.5">
            <Passes session={session} />
          </div>
          {/* A dream that stops before its journal must not hold the next one off. */}
          <Footer session={session} />
        </>
      )}
      {session && filed && (
        <p className="px-3 py-2 text-[12px] text-muted-foreground">
          {session.endedAt === undefined
            ? 'Journal filed below.'
            : `Journal filed below. Session complete.`}
        </p>
      )}
    </Card>
  )
}

/**
 * `dream.settled`: a compaction's dream settled, and whether it was worth a fresh chapter. Below the threshold we stay;
 * at or above it the user decides with the Fall asleep section below.
 */
export function SettledCard({ entry }: { entry: EntryRecord }) {
  const { session: id } = entry.data as SessionEntry
  const session = useSession(id)
  const outcome = session?.beforeCompaction?.outcome
  const pause = session?.beforeCompaction?.pause
  // Only the newest session falls asleep, as on the journal card.
  const newest = useDocOf(1, DreamDoc)?.sessions.at(-1)?.id === id
  return (
    <Card
      header={
        <>
          <MoonStarIcon className="size-3.5 text-brand" />
          <span className="text-foreground">Dream settled</span>
          <span>session {id}</span>
          {outcome && <span>{formatTime(outcome.at)}</span>}
        </>
      }
      session={id}
    >
      {!session || !outcome ? (
        <p className="px-3 py-3 text-[12px] text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="space-y-1 px-4 py-3" data-dream-settled={outcome.result}>
            <p className="text-[13px] text-foreground">
              {outcome.result === 'stay'
                ? 'Staying in this chapter'
                : pause !== undefined
                  ? 'A good moment for a fresh chapter'
                  : 'Worth a fresh chapter'}
            </p>
            {pause !== undefined ? (
              <p className="font-mono text-[11px] text-muted-foreground" data-dream-pause={pause}>
                Dreamed while you were away {awayFor(pause)} · {outcome.changes} change
                {outcome.changes === 1 ? '' : 's'} landed or applied · a fresh chapter starts lean
                before new work reads the full context again
              </p>
            ) : (
              <p className="font-mono text-[11px] text-muted-foreground">
                {outcome.changes} change{outcome.changes === 1 ? '' : 's'} landed or applied · a
                fresh chapter takes {outcome.threshold}
              </p>
            )}
          </div>
          {outcome.result !== 'stay' && (newest || session.sleep) && (
            <FallAsleep session={session} />
          )}
        </>
      )}
    </Card>
  )
}

/** How long the user was away, in whole hours: `9 h`. */
const awayFor = (ms: number) => `${Math.max(1, Math.round(ms / 3600_000))} h`

/** Above this many characters the journal folds behind "Read the journal". */
const FOLD = 600

/** `dream.journal`: what the dream learned, the journal, and its proposals followed until they land. */
export function JournalCard({ entry }: { entry: EntryRecord }) {
  return <SessionJournal id={(entry.data as SessionEntry).session} />
}

/**
 * Session `id`'s journal card. The pinned dream line shows it in a dialog with `current`: there Fall asleep always
 * shows (the settled card it would otherwise live on is not in the dialog), and once every proposal is settled it
 * leads, with the journal folded below it.
 */
export function SessionJournal({
  id,
  className,
  current,
}: {
  id: number
  className?: string
  current?: boolean
}) {
  const session = useSession(id)
  const journal = session?.journal
  // Only the newest session falls asleep; an older one keeps the record of the sleep it took.
  const newest = useDocOf(1, DreamDoc)?.sessions.at(-1)?.id === id
  const sleeps = !!session && (newest || !!session.sleep)
  // A compaction's dream that was worth a chapter offers Fall asleep on its settled card, below.
  const onSettledCard =
    !!session?.beforeCompaction?.outcome && session.beforeCompaction.outcome.result !== 'stay'
  const ready = current && !!session && sleepLeads(session, newest)
  return (
    <Card
      header={
        <>
          <MoonStarIcon className="size-3.5 text-brand" />
          <span className="text-foreground">Dream journal</span>
          <span>session {id}</span>
          {journal && <span>{formatTime(journal.at)}</span>}
        </>
      }
      className={className}
      session={id}
    >
      {!session ? (
        <p className="px-3 py-3 text-[12px] text-muted-foreground">Loading the journal…</p>
      ) : !journal ? (
        <div className="px-3 py-2.5">
          <Passes session={session} />
        </div>
      ) : ready ? (
        <>
          <div className="[&>section]:border-t-0" data-dream-current>
            <FallAsleep session={session} />
          </div>
          <Collapsible className="group/folded border-t border-border/60">
            <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1 px-4 py-2 font-mono text-[11px] text-muted-foreground hover:text-foreground">
              <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/folded:rotate-90 motion-reduce:transition-none" />
              {session.proposals.length === 0
                ? 'The journal'
                : `The journal and its ${session.proposals.length} proposal${session.proposals.length === 1 ? '' : 's'}`}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Learned lines={journal.learned} />
              <Text text={journal.text} />
              {session.proposals.length > 0 && <Proposals session={session} />}
            </CollapsibleContent>
          </Collapsible>
          <Footer session={session} />
        </>
      ) : (
        <>
          <Learned lines={journal.learned} />
          <Text text={journal.text} />
          {session.proposals.length > 0 && <Proposals session={session} />}
          <Footer session={session} />
          {sleeps && (current || !onSettledCard) && <FallAsleep session={session} />}
        </>
      )}
    </Card>
  )
}

/** Whether the session carries @ultimate's handoff, folded; or why it started without one. */
function HandoffNote({ handoff }: { handoff: Handoff }) {
  if (!handoff.text)
    return (
      <p
        className="border-b border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground"
        data-dream-handoff="missing"
      >
        Started without my handoff{handoff.missing && ` · ${handoff.missing}`}
      </p>
    )
  return (
    <Collapsible className="group/handoff border-b border-border/60 px-3 py-1.5" data-dream-handoff>
      <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground">
        <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/handoff:rotate-90 motion-reduce:transition-none" />
        Read my handoff{handoff.at !== undefined && ` · ${formatTime(handoff.at)}`}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2 pb-1 text-[13px] leading-relaxed">
        <MessageResponse>{handoff.text}</MessageResponse>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * `dream.handoff`: a dream waits for @ultimate's handoff. Live from the request: asked, recorded, and the session it
 * started (whose own card follows), or that it gave up.
 */
export function HandoffCard({ entry }: { entry: EntryRecord }) {
  const { task, automation } = entry.data as HandoffEntry
  const doc = useDocOf(1, DreamDoc)
  const waiting = doc?.waiting?.task === task ? doc.waiting : undefined
  const started = doc?.sessions.find((item) => item.handoff?.task === task)
  const status = started
    ? started.handoff?.text
      ? `Handed off · dream session ${started.id} started`
      : `Dream session ${started.id} started without my handoff`
    : waiting?.handoff
      ? `Handed off ${formatTime(waiting.handoff.at)} · the dream starts once nothing else works`
      : waiting
        ? 'Writing my handoff; the dream starts once it is recorded and nothing else works'
        : doc
          ? 'No dream started from this request'
          : 'Loading…'
  return (
    <Frame data-dream-handoff-request={task}>
      <header className="flex flex-wrap items-center gap-2 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <MoonIcon className="size-3.5 text-brand" />
        <span className="text-foreground">Handoff before dreaming</span>
        <span>
          {automation
            ? `${automation.pause !== undefined ? `you were away ${awayFor(automation.pause)}` : 'my context filled up'} · automation ${automation.id}`
            : 'you pressed Dream'}
        </span>
      </header>
      <p
        className="border-t border-border/60 px-3 py-2 text-[12px] text-muted-foreground"
        data-dream-handoff-status={
          started ? 'started' : waiting?.handoff ? 'handed-off' : waiting ? 'writing' : 'gone'
        }
      >
        {status}
      </p>
    </Frame>
  )
}

/** The three lines in Ultimate's own voice: the morning picture, set apart in a larger serif-free italic. */
function Learned({ lines }: { lines: string[] }) {
  return (
    <ul className="space-y-1.5 px-4 pt-4 pb-3" data-dream-learned>
      {lines.map((line) => (
        <li
          className="border-l-2 border-brand/30 pl-3 text-[14.5px] leading-snug text-foreground/90 italic"
          key={line}
        >
          {line}
        </li>
      ))}
    </ul>
  )
}

function Text({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  if (text.length <= FOLD)
    return (
      <div className="px-4 pb-3 text-[13px] leading-relaxed">
        <MessageResponse>{text}</MessageResponse>
      </div>
    )
  return (
    <Collapsible className="group/journal px-4 pb-3" onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground">
        <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/journal:rotate-90 motion-reduce:transition-none" />
        {open ? 'Hide the journal' : 'Read the journal'}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2 text-[13px] leading-relaxed">
        <MessageResponse>{text}</MessageResponse>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Where a proposal stands, as a pill; settled ones fade so the open ones draw the eye. */
const pills: Record<Proposal['status'], { label: string; className: string }> = {
  open: { label: 'open', className: 'bg-brand/15 text-brand' },
  approved: { label: 'in progress', className: 'bg-warning/15 text-warning' },
  landed: { label: 'landed', className: 'bg-success/15 text-success' },
  applied: { label: 'applied', className: 'bg-success/15 text-success' },
  rejected: { label: 'rejected', className: 'bg-muted text-muted-foreground' },
}

function Proposals({ session }: { session: Session }) {
  const { switchConversation } = useUltimate()
  return (
    <ul className="border-t border-border/60 py-1" data-dream-proposals>
      {session.proposals.map((proposal) => {
        const pill = pills[proposal.status]
        const settled = proposal.status === 'rejected'
        return (
          <li
            className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 px-4 py-1.5"
            data-proposal={proposal.id}
            data-status={proposal.status}
            key={proposal.id}
          >
            <div className="min-w-0">
              <p
                className={cn(
                  'text-[13px] leading-snug',
                  settled
                    ? 'text-muted-foreground line-through decoration-muted-foreground/40'
                    : 'text-foreground',
                )}
              >
                {proposal.title}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-muted-foreground">
                <span>{passLabels[proposal.pass]}</span>
                {proposal.size && <span>· {proposal.size}</span>}
                {proposal.retire && (
                  <span>
                    · retires memory <span className="text-foreground/80">{proposal.retire}</span>
                  </span>
                )}
                {proposal.reason && <span title="Why I decided it">· {proposal.reason}</span>}
                {proposal.branch !== undefined && (
                  <button
                    className="flex min-w-0 cursor-pointer items-center gap-1 hover:text-foreground"
                    onClick={() => switchConversation(proposal.branch!)}
                    title="Open its branch"
                    type="button"
                  >
                    · <ConversationRef id={proposal.branch} />
                  </button>
                )}
              </p>
            </div>
            <span
              className={cn(
                'rounded-full px-2 font-mono text-[10.5px] leading-[18px] whitespace-nowrap',
                pill.className,
              )}
            >
              {pill.label}
              {proposal.status === 'landed' && proposal.sha && ` ${proposal.sha.slice(0, 7)}`}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** "2 open · 1 in progress · 1 landed": what the user still has to decide, at a glance. */
function Tally({ proposals }: { proposals: readonly Proposal[] }) {
  const count = (status: Proposal['status']) =>
    proposals.filter((item) => item.status === status).length
  if (!proposals.length) return <span>no proposals</span>
  const parts: [number, string, string?][] = [
    [count('open'), 'open', 'text-brand'],
    [count('approved'), 'in progress'],
    [count('landed'), 'landed'],
  ]
  if (count('applied')) parts.push([count('applied'), 'applied'])
  return (
    <span className="font-mono text-[11px] text-muted-foreground" data-dream-tally>
      {parts.map(([n, word, tone], index) => (
        <span key={word}>
          {index > 0 && ' · '}
          <span className={cn(n > 0 && (tone ?? 'text-foreground/80'))}>{n}</span> {word}
        </span>
      ))}
    </span>
  )
}

function Footer({ session }: { session: Session }) {
  const [confirming, setConfirming] = useState(false)
  const [ending, setEnding] = useState(false)
  if (session.endedAt !== undefined)
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-4 py-2 font-mono text-[11px] text-muted-foreground">
        <Tally proposals={session.proposals} />
        <span className="ml-auto flex items-center gap-1.5">
          <MoonIcon className="size-3" />
          {session.journal ? 'Session complete' : 'Session ended'} · {formatTime(session.endedAt)}
        </span>
      </div>
    )
  const end = async () => {
    setEnding(true)
    try {
      await api.action(EndAction, { session: session.id })
    } finally {
      setEnding(false)
      setConfirming(false)
    }
  }
  return (
    <div className="flex min-h-10 flex-wrap items-center justify-end gap-2 border-t border-border/60 px-4 py-2 text-[12px]">
      {confirming ? (
        <>
          <span className="mr-auto text-muted-foreground">
            End the session? Open proposals stay undecided; approved ones still settle when their
            branches land.
          </span>
          <Button className="h-6" onClick={() => setConfirming(false)} size="xs" variant="ghost">
            Keep it open
          </Button>
          <Button
            className="h-6"
            disabled={ending}
            onClick={() => void end()}
            size="xs"
            variant="outline"
          >
            End session
          </Button>
        </>
      ) : (
        <>
          <span className="mr-auto">
            {session.journal ? (
              <Tally proposals={session.proposals} />
            ) : (
              <span className="text-muted-foreground">Dreaming…</span>
            )}
          </span>
          <Button className="h-6" onClick={() => setConfirming(true)} size="xs" variant="ghost">
            End session
          </Button>
        </>
      )}
    </div>
  )
}
