import {
  ArrowLeftIcon,
  CheckIcon,
  GitForkIcon,
  LoaderCircleIcon,
  SunriseIcon,
  Trash2Icon,
} from '@lucide/solid'
import { For, Match, Show, Switch, createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  ROOT,
  api,
  cn,
  errorMessage,
  formatTime,
  useConversations,
  useDocOf,
  useSystem,
  useUiState,
  writingAs,
  type EntryRecord,
  Card,
} from '@/sdk/solid'
import { OpenAction, SideChatsDoc, useSideChatFront } from '../side-chat/ui.solid.tsx'
import { StandingDoc } from '../subagents/ui.solid.tsx'
import {
  BusyBlocker,
  chapterLabel,
  Refusal,
  switchChapter,
  useBusyElsewhere,
} from './chapters.solid.tsx'
import type { Seed } from './types.ts'
import { ChapterStarted } from './entries.ts'
import type { ChapterEntry } from './refs.ts'

export const AWAKE_PROMPT = [
  "Check that you're awake in this new chapter. Answer from what you actually know now, briefly, one short section each:",
  '1. What is this project?',
  "2. What's open: to-dos, questions, work in flight?",
  '3. What are the rules you work by?',
  '4. Who am I, and who else do you work with?',
  "Say plainly when you don't know something rather than guessing.",
].join('\n')

const useChecks = () => useUiState<Record<string, number>>('ext.dream.awake', {})

const nouns: Record<keyof Seed['counts'], [string, string]> = {
  memories: ['memory', 'memories'],
  todos: ['to-do', 'to-dos'],
  questions: ['question', 'questions'],
  automations: ['automation', 'automations'],
  scripts: ['script', 'scripts'],
}

export function MorningCard(props: { entry: EntryRecord }) {
  const entry = () => ChapterStarted.is(props.entry) && props.entry.data
  return (
    <Show when={entry()}>
      {(data) => <Morning data={data()} at={props.entry.model?.[0]?.timestamp} />}
    </Show>
  )
}

function Morning(props: { data: ChapterEntry; at?: number }) {
  return (
    <Card data-dream-morning={props.data.name}>
      <header class="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <SunriseIcon class="size-3.5 text-brand" />
        <span class="text-foreground">{chapterLabel(props.data.number, props.data.name)}</span>
        <span>{props.at === undefined ? 'woke up' : `woke up ${formatTime(props.at)}`}</span>
      </header>
      <div class="space-y-3 px-4 pt-3.5 pb-3">
        <p class="text-[13px] leading-relaxed text-muted-foreground">
          A fresh start after{' '}
          <span class="text-foreground">
            {chapterLabel(props.data.from.number, props.data.from.name)}
          </span>
          . That chapter stays on disk, and I can still read it.
        </p>
        {!!props.data.learned?.length && (
          <ul class="space-y-1">
            <For each={props.data.learned}>
              {(line) => (
                <li class="border-l-2 border-brand/30 pl-3 text-[13.5px] leading-snug text-foreground/85">
                  {line}
                </li>
              )}
            </For>
          </ul>
        )}
        <Show when={props.data.carried}>{(counts) => <Carried counts={counts()} />}</Show>
      </div>
      <Awake data={props.data} />
    </Card>
  )
}

function Carried(props: { counts: Seed['counts'] }) {
  const parts = () =>
    (Object.keys(nouns) as (keyof Seed['counts'])[])
      .filter((kind) => props.counts[kind] > 0)
      .map((kind) => `${props.counts[kind]} ${nouns[kind][props.counts[kind] === 1 ? 0 : 1]}`)
      .join(' · ')
  return (
    <p class="font-mono text-[11px] text-muted-foreground" data-dream-carried>
      <span class="text-foreground/80">Carried</span>{' '}
      {parts() || 'nothing: no memory or open work came along'}
    </p>
  )
}

function Awake(props: { data: ChapterEntry }) {
  const standing = useDocOf(() => ROOT, StandingDoc)
  const ultimate = () => standing()?.ultimate
  const index = useDocOf(ultimate, SideChatsDoc)
  const conversations = useConversations()
  const [, setFront] = useSideChatFront()
  const [checks, setChecks] = useChecks()
  const [opening, setOpening] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const check = () => index()?.sides.find((item) => item.id === checks()[props.data.name])
  const waking = () => conversations().find((item) => item.id === ultimate())?.busy
  const open = async (source: Parameters<typeof writingAs>[0]) => {
    const conversationId = ultimate()
    const name = props.data.name
    if (conversationId === undefined) return
    setOpening(true)
    setFailure(undefined)
    try {
      const opened = await api.action(OpenAction, { text: AWAKE_PROMPT }, { conversationId })
      writingAs(source, () => {
        setChecks((previous) => ({ ...previous, [name]: opened.id }))
        setFront(opened.id)
      })
    } catch (error) {
      setFailure(errorMessage(error).replace(/^side-chat\/open: /, ''))
    } finally {
      setOpening(false)
    }
  }
  const footer = 'flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/60 px-4 py-2.5'

  return (
    <Switch
      fallback={
        <div class={footer} data-dream-awake="unchecked">
          <Button
            class="border-brand/50 hover:border-brand"
            data-dream-check
            disabled={opening() || waking() || ultimate() === undefined}
            onClick={(_, details) => open(details.source)}
            size="sm"
            variant="outline"
          >
            {opening() || waking() ? (
              <LoaderCircleIcon class="text-brand motion-safe:animate-spin" />
            ) : (
              <SunriseIcon class="text-brand" />
            )}
            Check that I'm awake
          </Button>
          <span class="min-w-0 flex-1 text-[12px] leading-snug text-muted-foreground">
            {waking()
              ? 'Still waking up…'
              : 'A side chat asks me what this project is, what is open, our rules and who we are.'}
          </span>
          {failure() && <p class="w-full text-[12px] text-error">{failure()}</p>}
        </div>
      }
    >
      <Match when={check()?.ended === 'injected'}>
        <div class={cn(footer, 'text-[12px]')} data-dream-awake="checked">
          <span class="flex items-center gap-1.5 text-foreground">
            <CheckIcon class="size-3.5 text-success" />
            Awake and checked
          </span>
          <span class="text-muted-foreground">the summary is below</span>
          <Button
            class="ml-auto h-6 text-muted-foreground"
            aria-label={`Check again after waking into ${props.data.name}`}
            disabled={opening() || waking()}
            onClick={(_, details) => open(details.source)}
            size="xs"
            variant="ghost"
          >
            Check again
          </Button>
          {failure() && <p class="w-full text-[12px] text-error">{failure()}</p>}
        </div>
      </Match>
      <Match when={check()?.ended === 'discarded'}>
        <>
          <Off data={props.data} onAgain={open} opening={opening() || !!waking()} />
          {failure() && <p class="px-4 pb-2.5 text-[12px] text-error">{failure()}</p>}
        </>
      </Match>
      <Match when={check()}>
        {(side) => (
          <div class={cn(footer, 'text-[12px]')} data-dream-awake="checking">
            <span class="flex items-center gap-1.5 text-muted-foreground">
              <GitForkIcon class="size-3.5 text-brand" />
              Checking in a side chat
            </span>
            <Button
              class="ml-auto h-6"
              aria-label={`Show the wake-up check for ${props.data.name}`}
              onClick={() => setFront(side().id)}
              size="xs"
              variant="ghost"
            >
              Show it
            </Button>
          </div>
        )}
      </Match>
    </Switch>
  )
}

function Off(props: {
  data: ChapterEntry
  onAgain: (source: Parameters<typeof writingAs>[0]) => Promise<void>
  opening: boolean
}) {
  const busy = useBusyElsewhere()
  const system = useSystem()
  const [switching, setSwitching] = createSignal(false)
  const [refusal, setRefusal] = createSignal<string>()
  const back = () => chapterLabel(props.data.from.number, props.data.from.name)
  const go = async () => {
    setSwitching(true)
    setRefusal(undefined)
    setRefusal(await switchChapter(back(), props.data.from.name, system()?.process.pid))
    setSwitching(false)
  }
  return (
    <div class="space-y-2.5 border-t border-border/60 px-4 pt-3 pb-3.5" data-dream-awake="off">
      <p class="flex items-start gap-2 text-[12.5px] leading-relaxed">
        <Trash2Icon class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span class="text-muted-foreground">
          <span class="text-foreground">You discarded the check.</span> If something is off here, go
          back: {props.data.from.name} is exactly as we left it, and this chapter stays too.
        </span>
      </p>
      {busy().length > 0 && <BusyBlocker busy={busy()} />}
      <Show when={refusal()}>{(text) => <Refusal text={text()} />}</Show>
      <div class="flex flex-wrap items-center gap-2 pl-5.5">
        <Button
          data-dream-back={props.data.from.name}
          disabled={switching() || busy().length > 0}
          onClick={go}
          size="sm"
          variant="outline"
        >
          {switching() ? <LoaderCircleIcon class="motion-safe:animate-spin" /> : <ArrowLeftIcon />}
          Back to {back()}
        </Button>
        <Button
          class="text-muted-foreground"
          aria-label={`Repeat discarded wake-up check for ${props.data.name}`}
          disabled={props.opening || switching()}
          onClick={(_, details) => props.onAgain(details.source)}
          size="sm"
          variant="ghost"
        >
          Check again
        </Button>
      </div>
    </div>
  )
}
