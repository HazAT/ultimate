/** @jsxImportSource @solidjs/web */
import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import {
  ArrowRightIcon,
  AudioLinesIcon,
  BookOpenIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  MicIcon,
  SquareArrowOutUpRightIcon,
  Volume2Icon,
} from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { createMemo, For, Match, Show, Switch, createSignal } from 'solid-js'
import { Message, MessageContent } from '@/components/ai/message.solid.tsx'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import {
  useProvided,
  UserText,
  UserView,
  cn,
  formatTime,
  plural,
  ROOT,
  switchConversation,
  useConversationId,
  useConversationSummary,
  useDocOf,
  useNow,
  useTranscript,
} from '@/sdk/solid'
import { ConversationPhase } from '../conversations/ui.solid.tsx'
import { Body, BubbleHeader } from '../messages/ui.solid.tsx'
import { StandingDoc } from '../subagents/refs.ts'
import { openAgentSource } from '../subagents/ui.solid.tsx'
import {
  VoiceAnswerEntry,
  VoiceContextEntry,
  VoiceHeardEntry,
  VoiceLineEntry,
  VoiceQuestionEntry,
  VoiceSessionEntry,
  VoiceUtteranceEntry,
} from './entries.ts'
import { mode, setFront, voiceMode } from './live.solid.tsx'
import type { VoiceAnswer, VoiceLine } from './refs.ts'

export function LineRow(props: { entry: EntryRecord }) {
  const data = () => (VoiceLineEntry.is(props.entry) ? props.entry.data : undefined)
  return <Show when={data()}>{(line) => <Line entry={props.entry} line={line()} />}</Show>
}

function Line(props: { entry: EntryRecord; line: VoiceLine }) {
  const conversation = useConversationId()
  const role = () => props.line.role
  return (
    <Switch>
      <Match
        when={
          role() === 'note' ||
          ((role() === 'ultimate' || role() === 'notice') && props.line.re !== undefined)
        }
      >
        {null}
      </Match>
      <Match when={role() === 'user' && props.line.forwarded}>
        <RequestCard entry={props.entry} line={props.line} />
      </Match>
      <Match when={role() === 'user'}>
        <Message class="mt-3 first:mt-0" data-voice-line="user" from="user">
          <MessageContent>
            <UserText text={props.line.text} />
          </MessageContent>
        </Message>
      </Match>
      <Match when={role() === 'notice'}>
        <div
          class="mt-3 flex items-center gap-2 font-mono text-[11.5px] text-warning first:mt-0"
          data-voice-line="notice"
        >
          <CircleAlertIcon class="size-3.5 shrink-0" />
          {props.line.text}
        </div>
      </Match>
      <Match when={role() === 'action'}>
        <div
          class="mt-2 flex items-center gap-2 font-mono text-[11.5px] text-muted-foreground first:mt-0"
          data-voice-line="action"
        >
          <Show when={props.line.go} fallback={<CheckIcon class="size-3 shrink-0 text-success" />}>
            <ArrowRightIcon class="size-3 shrink-0 text-brand" />
          </Show>
          <span class="min-w-0 truncate">{props.line.text}</span>
        </div>
      </Match>
      <Match when={role() === 'live'}>
        <div class="mt-2 flex gap-2 first:mt-0" data-voice-line="live">
          <AudioLinesIcon class="mt-[3px] size-3 shrink-0 text-muted-foreground/50" />
          <p class="min-w-0 flex-1 text-[12.5px] leading-relaxed break-words text-muted-foreground/70">
            {props.line.text}
          </p>
        </div>
      </Match>
      <Match when={role() === 'ultimate'}>
        <div class="mt-2 flex gap-2 first:mt-0" data-voice-line="ultimate">
          <Volume2Icon class="mt-[3px] size-3 shrink-0 text-muted-foreground/60" />
          <div class="min-w-0 flex-1">
            <p class="text-[13px] leading-relaxed break-words text-muted-foreground">
              <Spoken entry={props.entry.id} text={props.line.text} />
            </p>
            <Show when={props.line.source}>
              {(source) => (
                <Button
                  aria-label={`Read full answer for voice line #${props.entry.id}`}
                  class="mt-1 flex gap-1 rounded-none font-mono text-[11px] font-normal text-muted-foreground hover:text-foreground"
                  onClick={() => openSource(source(), props.entry, conversation())}
                  size={null}
                  title="Show @ultimate's full answer"
                  variant={null}
                >
                  <SquareArrowOutUpRightIcon class="size-3" />
                  full answer
                </Button>
              )}
            </Show>
          </div>
        </div>
      </Match>
    </Switch>
  )
}

function openSource(
  source: NonNullable<VoiceLine['source']>,
  entry: EntryRecord,
  conversation: ConversationId | undefined,
) {
  const answerBehindVoice = voiceMode().front && conversation === source.conversation
  setFront(false)
  openAgentSource(
    switchConversation,
    source,
    answerBehindVoice ? source : { conversation: entry.conversationId, entry: entry.id },
  )
}

function RequestCard(props: { entry: EntryRecord; line: VoiceLine }) {
  const transcript = useTranscript()
  const standing = useDocOf(() => ROOT, StandingDoc)
  const lines = createMemo(() =>
    transcript()
      .filter((entry) => VoiceLineEntry.is(entry))
      .filter((entry) => entry.data.re === props.entry.id),
  )
  const spokenEntry = () => lines().find((entry) => entry.data.role === 'ultimate')
  const spoken = () => spokenEntry()?.data
  const notice = () => lines().find((entry) => entry.data.role === 'notice')?.data
  const answer = createMemo(
    () =>
      transcript()
        .filter((entry) => VoiceAnswerEntry.is(entry))
        .find((entry) => entry.data.re === props.entry.id)?.data,
  )
  const state = () => (notice() ? 'failed' : answer() || spoken() ? 'answered' : 'working')
  return (
    <Show when={standing()?.ultimate}>
      {(main) => (
        <div class="mt-3 first:mt-0" data-voice-line="forwarded" data-forwarded={state()}>
          <section
            class="group/bubble mt-2 w-full min-w-0"
            data-compact-bubble
            data-sender="ultimate"
            data-ui="message-card"
          >
            <BubbleHeader at={props.line.at} from={main()} />
            <div class="[&>div]:px-0 [&>div]:pt-1.5 [&>div]:pb-0">
              <Asked text={props.line.text} />
            </div>
            <div
              class="mt-3 overflow-hidden rounded-lg border border-border/70 bg-card/60 empty-row [&>:first-child]:border-t-0"
              data-ui="message-card-body"
            >
              <Switch>
                <Match when={state() === 'working'}>
                  <Working main={main()} since={props.line.at} />
                </Match>
                <Match when={notice()}>
                  {(failure) => <Failed notice={failure()} spoken={spoken()} />}
                </Match>
                <Match when={state() === 'answered'}>
                  <Answer
                    answer={answer()}
                    entry={props.entry}
                    spoken={spoken()}
                    spokenId={spokenEntry()?.id}
                  />
                </Match>
              </Switch>
            </div>
          </section>
        </div>
      )}
    </Show>
  )
}

function Asked(props: { text: string }) {
  return (
    <div class="px-3 pt-2">
      <div class="flex items-center gap-1.5 font-mono text-[11px] text-brand">
        <MicIcon class="size-3 shrink-0" />
        <span class="font-semibold">You asked</span>
        <span class="text-muted-foreground">by voice</span>
      </div>
      <UserText
        class="mt-1.5 rounded-md border border-border/70 bg-secondary/60 px-3 py-2 text-[13px] leading-relaxed"
        text={props.text}
      />
    </div>
  )
}

function Working(props: { main: ConversationId; since?: number }) {
  const summary = useConversationSummary(() => props.main)
  const phase = useProvided(ConversationPhase, () => (summary()?.busy ? props.main : undefined))
  const now = useNow(1000, () => props.since !== undefined)
  return (
    <output class="flex items-center gap-2 px-3 py-3 font-mono text-[11px] text-muted-foreground">
      <LoaderCircleIcon class="size-3.5 shrink-0 text-brand motion-safe:animate-spin" />
      <span class="min-w-0 truncate text-brand">
        <Show when={phase()} fallback={summary()?.busy ? 'Working' : 'Waiting for @ultimate'}>
          {(value) => (
            <span class="inline-flex items-center gap-1.5">
              <span class="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand" />
              <span class="first-letter:uppercase">{value().word}</span>
            </span>
          )}
        </Show>
      </span>
      <Show when={props.since !== undefined}>
        <span class="ml-auto tabular-nums">{clock(now() - props.since!)}</span>
      </Show>
    </output>
  )
}

export function clock(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function Answer(props: {
  answer?: VoiceAnswer
  spoken?: VoiceLine
  spokenId?: number
  entry: EntryRecord
}) {
  const [open, setOpen] = createSignal(false)
  const conversation = useConversationId()
  const source = () => props.answer?.source
  const full = () => props.answer && (open() || !props.spoken)
  return (
    <>
      <div class={cn(!open() && !props.spoken && 'line-clamp-4')}>
        <Show
          when={
            !full() &&
            props.spoken &&
            props.spokenId !== undefined &&
            mode().speaking?.entry === props.spokenId
          }
          fallback={<Body text={full() ? props.answer!.text : (props.spoken?.text ?? '')} />}
        >
          <p class="min-w-0 px-3 py-3 text-[13px] leading-relaxed break-words">
            <Spoken entry={props.spokenId!} text={props.spoken!.text} />
          </p>
        </Show>
      </div>
      <Show when={props.answer || source()}>
        <footer class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          <Show when={props.answer && props.spoken}>
            <Button
              aria-expanded={open() ? 'true' : 'false'}
              aria-label={`${open() ? 'Show spoken version' : 'Show full answer'} for voice request #${props.entry.id}`}
              class="flex gap-1 rounded-none font-mono text-[11px] font-normal hover:text-foreground"
              onClick={() => setOpen(!open())}
              size={null}
              variant={null}
            >
              <ChevronRightIcon class={cn('size-3 transition-transform', open() && 'rotate-90')} />
              {open() ? 'Spoken version' : 'Full answer'}
            </Button>
          </Show>
          <Show when={props.answer && !props.spoken}>
            <span>speaking…</span>
          </Show>
          <Show when={source()}>
            {(target) => (
              <Button
                aria-label={`Open answer to voice request #${props.entry.id} in @ultimate`}
                class="ml-auto flex gap-1 rounded-none font-mono text-[11px] font-normal hover:text-foreground"
                onClick={() => openSource(target(), props.entry, conversation())}
                size={null}
                title="Open @ultimate's conversation at this answer"
                variant={null}
              >
                <SquareArrowOutUpRightIcon class="size-3" />
                Open in @ultimate
              </Button>
            )}
          </Show>
        </footer>
      </Show>
    </>
  )
}

function Failed(props: { notice: VoiceLine; spoken?: VoiceLine }) {
  return (
    <>
      <Show when={props.spoken}>{(spoken) => <Body text={spoken().text} />}</Show>
      <footer class="flex items-center gap-1.5 border-t border-border/60 px-3 py-1.5 font-mono text-[11px] text-destructive">
        <CircleAlertIcon class="size-3 shrink-0" />
        {props.notice.text}
      </footer>
    </>
  )
}

function VoiceMark(props: { children: JSX.Element; class?: string }) {
  return (
    <span
      class={cn(
        '-mt-1 flex items-center gap-1 font-mono text-[10.5px] text-muted-foreground/70',
        props.class,
      )}
    >
      <MicIcon class="size-2.5" />
      {props.children}
    </span>
  )
}

export function SessionRow(props: { entry: EntryRecord }) {
  const data = () => (VoiceSessionEntry.is(props.entry) ? props.entry.data : undefined)
  return (
    <Show when={data()}>
      {(session) => (
        <div
          class="my-3 flex items-center gap-3 font-mono text-[11px] text-muted-foreground"
          data-voice-session={session().phase}
        >
          <hr class="h-px flex-1 border-0 border-t border-dashed border-border" />
          <span class="flex shrink-0 items-center gap-1.5">
            <AudioLinesIcon class={cn('size-3', session().phase === 'started' && 'text-brand')} />
            {session().phase === 'started'
              ? `Live · ${formatTime(session().at)}`
              : `Ended · ${session().seconds === undefined ? formatTime(session().at) : `${Math.max(1, Math.round(session().seconds! / 60))} min`}`}
          </span>
          <hr
            aria-hidden="true"
            class="h-px flex-1 border-0 border-t border-dashed border-border"
          />
        </div>
      )}
    </Show>
  )
}

export function ContextRow(props: { entry: EntryRecord }) {
  const transcript = useTranscript()
  const data = () => (VoiceContextEntry.is(props.entry) ? props.entry.data : undefined)
  const newest = createMemo(
    () => transcript().findLast((entry) => entry.kind === 'voice.context')?.id === props.entry.id,
  )
  const counts = () => {
    const brief = data()
    if (!brief) return ''
    if (brief.error) return `couldn't load · ${brief.error}`
    return [
      `memory ${brief.memories}`,
      plural(brief.requests, 'recent request'),
      `${brief.branches} open branch${brief.branches === 1 ? '' : 'es'}`,
      ...(brief.questions === undefined ? [] : [plural(brief.questions, 'open question')]),
    ].join(' · ')
  }
  return (
    <Show when={data()}>
      {(brief) => (
        <Collapsible
          class={cn(
            'group/context my-2 rounded-md border border-border/60 bg-muted/20',
            !newest() && 'opacity-60',
          )}
          data-voice-context={newest() ? 'current' : 'past'}
        >
          <CollapsibleTrigger
            aria-label={`${brief().again ? 'Context again' : 'Context'} for voice entry #${props.entry.id}`}
            class="flex w-full min-w-0 items-center gap-1.5 px-2.5 py-1.5 text-left font-mono text-[11px] text-muted-foreground hover:text-foreground"
          >
            <ChevronRightIcon class="size-3 shrink-0 transition-transform group-data-open/context:rotate-90" />
            <BookOpenIcon
              class={cn('size-3 shrink-0', brief().error ? 'text-error' : 'text-brand')}
            />
            <span class="shrink-0 text-foreground/80">
              {brief().again ? 'Context again' : 'Context'}
            </span>
            <span class="min-w-0 truncate">· {counts()}</span>
            <Show when={!brief().error}>
              <span class="ml-auto shrink-0 pl-2 tabular-nums opacity-70">
                ~{(brief().tokens / 1000).toFixed(1)}k tokens
              </span>
            </Show>
          </CollapsibleTrigger>
          <Show when={!brief().error}>
            <CollapsibleContent class="max-h-[28rem] overflow-y-auto border-t border-border/60 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
              <Markdown
                text={brief().text.replace(/^<voice_context>\n|\n<\/voice_context>$/g, '')}
              />
            </CollapsibleContent>
          </Show>
        </Collapsible>
      )}
    </Show>
  )
}

export function UtteranceRow(props: { entry: EntryRecord }) {
  const data = () => (VoiceUtteranceEntry.is(props.entry) ? props.entry.data : undefined)
  const message = () => {
    const item = props.entry.model?.[0]
    return item?.role === 'user' ? item : undefined
  }
  return (
    <Show when={data() && message()}>
      {(user) => (
        <div data-voice-utterance>
          <UserView entry={props.entry} message={user()} text={data()?.text} />
          <VoiceMark class="-mt-3 justify-end">by voice</VoiceMark>
        </div>
      )}
    </Show>
  )
}

export function HeardRow(props: { entry: EntryRecord }) {
  const data = () => (VoiceHeardEntry.is(props.entry) ? props.entry.data : undefined)
  return (
    <Show when={data()}>
      {(heard) => (
        <Message class="mt-4 first:mt-0" data-voice-line="user" from="user">
          <MessageContent class="group-[.is-user]:bg-secondary/50 group-[.is-user]:text-[13px] group-[.is-user]:text-foreground/80">
            <UserText text={heard().text} />
          </MessageContent>
        </Message>
      )}
    </Show>
  )
}

function Spoken(props: { entry: number; text: string }) {
  const speaking = createMemo(() =>
    mode().speaking?.entry === props.entry ? mode().speaking : undefined,
  )
  const words = createMemo(() => props.text.split(' '))
  return (
    <Show when={speaking()} fallback={props.text}>
      {(speech) => (
        <For each={words()} keyed={false}>
          {(word, index) => (
            <span
              class={cn('transition-opacity duration-300', index >= speech().words && 'opacity-25')}
            >
              {index ? ' ' : ''}
              {word()}
            </span>
          )}
        </For>
      )}
    </Show>
  )
}

export function LiveTurn() {
  const id = useConversationId()
  const standing = useDocOf(() => ROOT, StandingDoc)
  const transcript = useTranscript()
  const last = createMemo(() => transcript().findLast((entry) => VoiceHeardEntry.is(entry))?.data)
  const text = createMemo(() => {
    if (id() === undefined || id() !== standing()?.voice) return undefined
    const { partial, sending } = mode()
    return partial ?? (last()?.text === sending?.text ? undefined : sending?.text)
  })
  const words = createMemo(() => text()?.split(' '))
  return (
    <Show when={text()}>
      <Message class="mt-4" data-voice-line="hearing" from="user">
        <MessageContent class="group-[.is-user]:bg-secondary/50 group-[.is-user]:text-[13px] group-[.is-user]:text-foreground/80">
          <p
            class="flex max-h-[13.5rem] flex-col justify-end overflow-hidden break-words whitespace-pre-wrap [mask-image:linear-gradient(to_bottom,transparent,black_4.5rem)]"
            data-voice-partial
          >
            <span>
              <For each={words()} keyed={false}>
                {(word, index) => (
                  <span class="animate-fade-in">
                    {index ? ' ' : ''}
                    {word()}
                  </span>
                )}
              </For>
              <Show when={mode().partial !== undefined}>
                <span class="ml-1 inline-block size-1.5 rounded-full bg-brand align-middle motion-safe:animate-pulse" />
              </Show>
            </span>
          </p>
        </MessageContent>
      </Message>
    </Show>
  )
}

export function QuestionRow(props: { entry: EntryRecord }) {
  const data = () => (VoiceQuestionEntry.is(props.entry) ? props.entry.data : undefined)
  return (
    <Show when={data()}>
      {(question) => (
        <div
          class="mt-2 flex items-center gap-2 font-mono text-[11.5px] text-warning first:mt-0"
          data-voice-line="question"
        >
          <CircleAlertIcon class="size-3.5 shrink-0" />
          <span class="min-w-0 truncate">
            {question().title} asks · {question().gist}
          </span>
        </div>
      )}
    </Show>
  )
}
