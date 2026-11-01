/**
 * The Fall asleep card: what @ultimate prepared for the next chapter (its name, three lines it learned, its handover),
 * then each step live from `sleep`: packing the seed, the last backup, the switch. A failed step says what failed and
 * that we stay in this chapter.
 */
import { ChevronRightIcon, LoaderCircleIcon, MoonIcon, MoonStarIcon } from 'lucide-react'
import { useState } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Card, formatTime, useDocOf, useNow, useSystem, useUltimate } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import {
  BusyBlocker,
  CHAPTER_NAME,
  chapterLabel,
  chaptersDialog,
  fallAsleep,
  useBusyElsewhere,
  useChapters,
} from './chapters.tsx'
import { Moon } from './moon.tsx'
import { DreamDoc } from './refs.ts'
import type { Prepared, Sleep } from './refs.ts'

type Step = Exclude<Sleep['phase'], 'asleep' | 'failed'>
const STEPS: Step[] = ['seeding', 'backing up', 'switching']

const titles: Record<Step, string> = {
  seeding: 'Pack what carries over',
  'backing up': 'Back up this chapter',
  switching: 'Switch',
}

/** `0:42` since `at`, for the step that is running. */
const elapsed = (now: number, at: number) => {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** `dream.prepared`: the card for the preparation it announced; a later one replaces it. */
export function PreparedCard({ entry }: { entry: EntryRecord }) {
  const doc = useDocOf(1, DreamDoc)
  const at = (entry.data as { at: number }).at
  if (doc === undefined) return null
  if (doc?.prepared?.at !== at)
    return (
      <Card data-dream-prepared="replaced">
        <p className="flex items-center gap-2 px-3 py-2 font-mono text-[0.6875rem] text-muted-foreground">
          <MoonIcon className="size-3.5" />
          Next chapter prepared {formatTime(at)} · replaced by a later one
        </p>
      </Card>
    )
  return <NextChapter prepared={doc.prepared} sleep={doc.sleep} />
}

/** The prepared next chapter and the way into it; the status line's dialog shows the same card. */
export function NextChapter({
  prepared,
  sleep,
  className,
}: {
  prepared: Prepared
  sleep?: Sleep
  className?: string
}) {
  return (
    <Card
      attention={!sleep || sleep.phase === 'failed'}
      className={className}
      data-dream-prepared={prepared.chapter}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[0.6875rem] text-muted-foreground">
        <MoonStarIcon className="size-3.5 text-brand" />
        <span className="text-foreground">Ready for a fresh chapter</span>
        <span>{formatTime(prepared.at)}</span>
      </header>
      <ul className="space-y-1.5 px-4 pt-4 pb-3" data-dream-learned>
        {prepared.learned.map((line) => (
          <li
            className="border-l-2 border-brand/30 pl-3 text-[0.9062rem] leading-snug text-foreground/90"
            key={line}
          >
            {line}
          </li>
        ))}
      </ul>
      <Collapsible className="group/handoff px-4 pb-3" data-dream-handoff>
        <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 font-mono text-[0.6875rem] text-muted-foreground hover:text-foreground">
          <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/handoff:rotate-90 motion-reduce:transition-none" />
          Read my handover
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2 text-[0.8125rem] leading-relaxed">
          <MessageResponse>{prepared.handoff}</MessageResponse>
        </CollapsibleContent>
      </Collapsible>
      {sleep && sleep.phase !== 'failed' ? (
        <Progress sleep={sleep} />
      ) : (
        <Ready failed={sleep} prepared={prepared} />
      )}
    </Card>
  )
}

function Ready({ prepared, failed }: { prepared: Prepared; failed?: Sleep }) {
  const chapters = useChapters()
  const busy = useBusyElsewhere()
  const pid = useSystem()?.process.pid
  const [name, setName] = useState(failed?.chapter ?? prepared.chapter)
  const [starting, setStarting] = useState(false)
  const [refusal, setRefusal] = useState<string>()
  const number = (chapters?.chapters.length ?? 0) + 1
  const taken = chapters?.chapters.some((item) => item.name === name)
  const invalid = !CHAPTER_NAME.test(name)
  const blocked = busy.length > 0
  const start = async () => {
    setStarting(true)
    setRefusal(undefined)
    setRefusal(await fallAsleep(chapterLabel(number, name), name, pid))
    setStarting(false)
  }
  return (
    <section className="border-t border-border/60 px-4 pt-3 pb-3.5" data-dream-sleep="ready">
      {failed && <Failed sleep={failed} />}
      <div className="flex items-start gap-3">
        <MoonIcon className="mt-0.5 size-4 shrink-0 text-brand" />
        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="space-y-0.5">
            <p className="text-[0.8125rem] text-foreground">
              {failed ? 'Try falling asleep again' : 'Fall asleep'}
            </p>
            <p className="text-[0.75rem] leading-relaxed text-muted-foreground">
              I carry my memory, open work and this handover into a fresh chapter and wake up there.
              This one stays on disk; you can come back any time.
            </p>
          </div>
          <label className="flex max-w-full items-center rounded-md border border-border bg-background font-mono text-[0.7812rem] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring sm:w-fit">
            <span className="shrink-0 border-r border-border/70 px-2 py-1 text-muted-foreground">
              Chapter {number} ·
            </span>
            <input
              aria-invalid={invalid || taken || undefined}
              aria-label="Name of the new chapter"
              className="min-w-0 flex-1 bg-transparent px-2 py-1 text-foreground outline-none placeholder:text-muted-foreground sm:w-56 sm:flex-none"
              data-dream-chapter-name
              disabled={starting}
              maxLength={40}
              onChange={(event) => setName(event.target.value.toLowerCase().replaceAll(' ', '-'))}
              onKeyDown={(event) =>
                event.key === 'Enter' && !invalid && !taken && !blocked && !starting && start()
              }
              placeholder="two-or-three-words"
              spellCheck={false}
              value={name}
            />
          </label>
          {(taken || (invalid && name)) && (
            <p className="text-[0.7188rem] text-warning">
              {taken
                ? `There already is a chapter ${name}; pick another name, or switch to it from Chapters.`
                : 'Lowercase letters, digits and dashes, up to 40.'}
            </p>
          )}
          {blocked && <BusyBlocker busy={busy} />}
          {refusal && (
            <p className="text-[0.75rem] leading-relaxed" role="alert">
              <span className="text-error">Didn't start.</span>{' '}
              <span className="text-muted-foreground">{refusal}</span>
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Button
              className="border-brand/50 hover:border-brand"
              data-dream-asleep
              disabled={blocked || invalid || !!taken || starting || !chapters}
              onClick={() => void start()}
              size="sm"
              variant="outline"
            >
              {starting ? (
                <LoaderCircleIcon className="text-brand motion-safe:animate-spin" />
              ) : (
                <MoonIcon className="text-brand" />
              )}
              Fall asleep
            </Button>
            <span className="font-mono text-[0.6875rem] text-muted-foreground">
              under a minute · no model · restarts the server
            </span>
          </div>
        </div>
      </div>
    </section>
  )
}

/** What a failed sleep stopped at, its error, and that nothing moved. */
function Failed({ sleep }: { sleep: Sleep }) {
  const chapters = useChapters()
  return (
    <div
      className="mb-3 rounded-md border border-error/30 bg-error/5 px-3 py-2.5"
      data-dream-sleep="failed"
      role="alert"
    >
      <p className="flex items-center gap-2 text-[0.7812rem] text-foreground">
        <Moon status="failed" />
        Falling asleep failed
        <span className="ml-auto font-mono text-[0.6875rem] text-muted-foreground">
          {formatTime(sleep.at)}
        </span>
      </p>
      {(sleep.backup?.id || sleep.backup?.skipped) && (
        <p className="mt-1 font-mono text-[0.6875rem] text-muted-foreground">
          {sleep.backup.id && `backed up ${sleep.backup.id.slice(0, 12)}`}
          {sleep.backup.skipped && `backup skipped: ${sleep.backup.skipped}`}
        </p>
      )}
      {sleep.error && (
        <p className="mt-1.5 font-mono text-[0.6875rem] leading-relaxed break-words text-error/90">
          {sleep.error.replace(/^Error: /, '')}
        </p>
      )}
      <p className="mt-2 text-[0.75rem] text-muted-foreground">
        Nothing moved: we're still in{' '}
        <span className="text-foreground">
          {chapters ? chapterLabel(chapters.number, chapters.active) : 'this chapter'}
        </span>
        .
      </p>
    </div>
  )
}

/** The three steps while a sleep runs, and the outcome once it switched (seen when this chapter is opened again). */
function Progress({ sleep }: { sleep: Sleep }) {
  const chapters = useChapters()
  const actions = useUltimate()
  const running = sleep.phase !== 'asleep'
  const now = useNow(1000, running)
  const current = STEPS.indexOf(sleep.phase as Step)
  const target = chapters?.chapters.find((item) => item.name === sleep.chapter)
  // A running sleep makes the next chapter; a finished one names it as listed (by name alone if it is gone).
  const number = running ? (chapters?.chapters.length ?? 0) + 1 : target?.number
  const label = number ? chapterLabel(number, sleep.chapter) : sleep.chapter
  if (!running)
    return (
      <section
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-4 py-2.5 text-[0.75rem]"
        data-dream-sleep="asleep"
      >
        <MoonIcon className="size-3.5 text-brand" />
        <span className="text-muted-foreground">
          Fell asleep into <span className="text-foreground">{label}</span> · {formatTime(sleep.at)}
        </span>
        {chapters && chapters.active !== sleep.chapter && (
          <button
            className="ml-auto cursor-pointer font-mono text-[0.6875rem] text-foreground/85 hover:text-foreground"
            onClick={() => actions.open(chaptersDialog)}
            type="button"
          >
            Chapters…
          </button>
        )}
      </section>
    )
  return (
    <section
      aria-live="polite"
      className="border-t border-border/60 px-4 pt-3 pb-3.5"
      data-dream-sleep={sleep.phase}
    >
      <p className="flex flex-wrap items-baseline gap-x-2 text-[0.8125rem] text-foreground">
        Falling asleep
        <span className="font-mono text-[0.7188rem] text-muted-foreground">into {label}</span>
      </p>
      <ol className="mt-2 space-y-1.5">
        {STEPS.map((step, index) => {
          const status =
            index < current ? 'done' : index === current ? 'running' : ('waiting' as const)
          return (
            <li data-status={status} data-step={step} key={step}>
              <div className="grid grid-cols-[0.75rem_minmax(0,1fr)_auto] items-baseline gap-x-2 text-[0.75rem] leading-5">
                <Moon className="translate-y-0.5 self-start" status={status} />
                <span
                  className={status === 'waiting' ? 'text-muted-foreground' : 'text-foreground'}
                >
                  {titles[step]}
                  <span className="text-muted-foreground"> {detail(step, sleep)}</span>
                </span>
                {status === 'running' && (
                  <span className="font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
                    {elapsed(now, sleep.at)}
                  </span>
                )}
              </div>
            </li>
          )
        })}
      </ol>
      <p className="mt-2.5 text-[0.7188rem] text-muted-foreground">
        Start no other work until I'm asleep — anything that starts now cancels the switch.
      </p>
    </section>
  )
}

/** One step's quiet second half: what it does, or what it found. */
function detail(step: Step, sleep: Sleep) {
  if (step === 'seeding') return '— memories, open to-dos, questions, automations, my handover'
  if (step === 'backing up') {
    if (sleep.backup?.id) return `— backup ${sleep.backup.id.slice(0, 12)}`
    if (sleep.backup?.skipped) return `— skipped: ${sleep.backup.skipped}`
    return '— the last cloud backup of this chapter'
  }
  return '— the server restarts into the new chapter'
}
