/**
 * `dream.chapter`: the morning card in @ultimate's conversation of a new chapter. Where we came from, what came along,
 * and the check that Ultimate really woke up: a side chat that asks it what it knows. Summarize & inject marks the
 * check done; Discard is the "something's off" path, and leads back to the chapter we came from.
 */
import {
  ArrowLeftIcon,
  CheckIcon,
  GitForkIcon,
  LoaderCircleIcon,
  SunriseIcon,
  Trash2Icon,
} from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  api,
  Card,
  cn,
  errorMessage,
  formatTime,
  useConversations,
  useDocOf,
  useSystem,
  useUiState,
} from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { OpenAction, SideChatsDoc, useSideChatFront } from '../side-chat/ui.tsx'
import { StandingDoc } from '../subagents/ui.tsx'
import { BusyBlocker, chapterLabel, Refusal, switchChapter, useBusyElsewhere } from './chapters.tsx'
import type { Seed } from './types.ts'

/** `dream.chapter` entry data; `learned` and `carried` came later, so older entries lack them. */
export type ChapterEntry = {
  from: { name: string; number: number }
  number: number
  name: string
  learned?: string[]
  carried?: Seed['counts']
}

/** The first input of the wake-up side chat: the four things a colleague back from leave should know. */
export const AWAKE_PROMPT = [
  "Check that you're awake in this new chapter. Answer from what you actually know now, briefly, one short section each:",
  '1. What is this project?',
  "2. What's open: to-dos, questions, work in flight?",
  '3. What are the rules you work by?',
  '4. Who am I, and who else do you work with?',
  "Say plainly when you don't know something rather than guessing.",
].join('\n')

/** The side chat that checked each chapter, by chapter name: the card follows it to its ending. */
const useChecks = () => useUiState<Record<string, number>>('ext.dream.awake', {})

const nouns: Record<keyof Seed['counts'], [string, string]> = {
  memories: ['memory', 'memories'],
  todos: ['to-do', 'to-dos'],
  questions: ['question', 'questions'],
  automations: ['automation', 'automations'],
  scripts: ['script', 'scripts'],
}

export function MorningCard({ entry }: { entry: EntryRecord }) {
  const data = entry.data as unknown as ChapterEntry
  const at = entry.model?.[0]?.timestamp
  return (
    <Card data-dream-morning={data.name}>
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[0.6875rem] text-muted-foreground">
        <SunriseIcon className="size-3.5 text-brand" />
        <span className="text-foreground">{chapterLabel(data.number, data.name)}</span>
        <span>{at === undefined ? 'woke up' : `woke up ${formatTime(at)}`}</span>
      </header>
      <div className="space-y-3 px-4 pt-3.5 pb-3">
        <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
          A fresh start after{' '}
          <span className="text-foreground">{chapterLabel(data.from.number, data.from.name)}</span>.
          That chapter stays on disk, and I can still read it.
        </p>
        {data.learned && data.learned.length > 0 && (
          <ul className="space-y-1">
            {data.learned.map((line) => (
              <li
                className="border-l-2 border-brand/30 pl-3 text-[0.8438rem] leading-snug text-foreground/85"
                key={line}
              >
                {line}
              </li>
            ))}
          </ul>
        )}
        {data.carried && <Carried counts={data.carried} />}
      </div>
      <Awake data={data} />
    </Card>
  )
}

/** "Carried 12 memories · 3 to-dos · 2 automations": only what there was. */
function Carried({ counts }: { counts: Seed['counts'] }) {
  const parts = (Object.keys(nouns) as (keyof Seed['counts'])[])
    .filter((kind) => counts[kind] > 0)
    .map((kind) => `${counts[kind]} ${nouns[kind][counts[kind] === 1 ? 0 : 1]}`)
  return (
    <p className="font-mono text-[0.6875rem] text-muted-foreground" data-dream-carried>
      <span className="text-foreground/80">Carried</span>{' '}
      {parts.length ? parts.join(' · ') : 'nothing: no memory or open work came along'}
    </p>
  )
}

/** The check that I woke up well, followed to its side chat's ending; Discard leads back to the chapter before. */
function Awake({ data }: { data: ChapterEntry }) {
  const ultimate = useDocOf(1, StandingDoc)?.ultimate
  const index = useDocOf(ultimate, SideChatsDoc) ?? undefined
  const conversations = useConversations()
  const [, setFront] = useSideChatFront()
  const [checks, setChecks] = useChecks()
  const [opening, setOpening] = useState(false)
  const [failure, setFailure] = useState<string>()
  const side = checks[data.name]
  const check = side === undefined ? undefined : index?.sides.find((item) => item.id === side)
  const waking = conversations.find((item) => item.id === ultimate)?.busy
  const open = async () => {
    if (ultimate === undefined) return
    setOpening(true)
    setFailure(undefined)
    try {
      const opened = await api.action(
        OpenAction,
        { text: AWAKE_PROMPT },
        { conversationId: ultimate },
      )
      setChecks((previous) => ({ ...previous, [data.name]: opened.id }))
      setFront(opened.id)
    } catch (error) {
      setFailure(errorMessage(error).replace(/^side-chat\/open: /, ''))
    } finally {
      setOpening(false)
    }
  }
  const footer = 'flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/60 px-4 py-2.5'

  if (check?.ended === 'injected')
    return (
      <div className={cn(footer, 'text-[0.75rem]')} data-dream-awake="checked">
        <span className="flex items-center gap-1.5 text-foreground">
          <CheckIcon className="size-3.5 text-success" />
          Awake and checked
        </span>
        <span className="text-muted-foreground">the summary is below</span>
        <Button
          className="ml-auto h-6 text-muted-foreground"
          disabled={opening || waking}
          onClick={() => void open()}
          size="xs"
          variant="ghost"
        >
          Check again
        </Button>
        {failure && <p className="w-full text-[0.75rem] text-error">{failure}</p>}
      </div>
    )

  if (check?.ended === 'discarded')
    return (
      <>
        <Off data={data} onAgain={() => void open()} opening={opening || !!waking} />
        {failure && <p className="px-4 pb-2.5 text-[0.75rem] text-error">{failure}</p>}
      </>
    )

  if (check)
    return (
      <div className={cn(footer, 'text-[0.75rem]')} data-dream-awake="checking">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <GitForkIcon className="size-3.5 text-brand" />
          Checking in a side chat
        </span>
        <Button
          className="ml-auto h-6"
          onClick={() => setFront(check.id)}
          size="xs"
          variant="ghost"
        >
          Show it
        </Button>
      </div>
    )

  return (
    <div className={footer} data-dream-awake="unchecked">
      <Button
        className="border-brand/50 hover:border-brand"
        data-dream-check
        disabled={opening || waking || ultimate === undefined}
        onClick={() => void open()}
        size="sm"
        variant="outline"
      >
        {opening || waking ? (
          <LoaderCircleIcon className="text-brand motion-safe:animate-spin" />
        ) : (
          <SunriseIcon className="text-brand" />
        )}
        Check that I'm awake
      </Button>
      <span className="min-w-0 flex-1 text-[0.75rem] leading-snug text-muted-foreground">
        {waking
          ? 'Still waking up…'
          : 'A side chat asks me what this project is, what is open, our rules and who we are.'}
      </span>
      {failure && <p className="w-full text-[0.75rem] text-error">{failure}</p>}
    </div>
  )
}

/** After a discarded check: the way back to the chapter we came from, or another try. */
function Off({
  data,
  onAgain,
  opening,
}: {
  data: ChapterEntry
  onAgain: () => void
  opening: boolean
}) {
  const busy = useBusyElsewhere()
  const pid = useSystem()?.process.pid
  const [switching, setSwitching] = useState(false)
  const [refusal, setRefusal] = useState<string>()
  const back = chapterLabel(data.from.number, data.from.name)
  const go = async () => {
    setSwitching(true)
    setRefusal(undefined)
    setRefusal(await switchChapter(back, data.from.name, pid))
    setSwitching(false)
  }
  return (
    <div className="space-y-2.5 border-t border-border/60 px-4 pt-3 pb-3.5" data-dream-awake="off">
      <p className="flex items-start gap-2 text-[0.7812rem] leading-relaxed">
        <Trash2Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">
          <span className="text-foreground">You discarded the check.</span> If something is off
          here, go back: {data.from.name} is exactly as we left it, and this chapter stays too.
        </span>
      </p>
      {busy.length > 0 && <BusyBlocker busy={busy} />}
      {refusal && <Refusal text={refusal} />}
      <div className="flex flex-wrap items-center gap-2 pl-5.5">
        <Button
          data-dream-back={data.from.name}
          disabled={switching || busy.length > 0}
          onClick={() => void go()}
          size="sm"
          variant="outline"
        >
          {switching ? (
            <LoaderCircleIcon className="motion-safe:animate-spin" />
          ) : (
            <ArrowLeftIcon />
          )}
          Back to {back}
        </Button>
        <Button
          className="text-muted-foreground"
          disabled={opening || switching}
          onClick={onAgain}
          size="sm"
          variant="ghost"
        >
          Check again
        </Button>
      </div>
    </div>
  )
}
