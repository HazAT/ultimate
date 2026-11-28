import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { GitForkIcon, ChevronRight, SquareArrowOutUpRightIcon } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { For, Show, useContext } from 'solid-js'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import { ToolStatusIcon } from '@/components/ai/tool.solid.tsx'
import {
  Card,
  ConversationScope,
  formatTime,
  showSurface,
  switchConversation,
  useConversationId,
  useDocOf,
  type ToolCallView,
} from '@/sdk/solid'
import { QUIET_MINUTES } from './entries.shared.ts'
import { SideChatForkDoc, type SideChatHandoff, type SideChatSummary } from './refs.ts'
import { useSourceName } from './side.solid.tsx'
import { closingReason } from './side.web.ts'

type Brief = Omit<SideChatHandoff, 'from'>

function Section(props: { label: string; items: readonly string[] | undefined }) {
  return (
    <Show when={props.items?.length}>
      <div class="mt-2 font-mono text-[11px] text-muted-foreground">{props.label}</div>
      <ul class="mt-0.5 list-disc pl-4">
        <For each={props.items}>{(item) => <li>{item}</li>}</For>
      </ul>
    </Show>
  )
}

function Details(props: { brief: Partial<Brief> }) {
  return (
    <>
      <Section items={props.brief.decided} label="Decided" />
      <Section items={props.brief.open} label="Open" />
      <Section items={props.brief.attachments} label="Screenshots" />
      <Show when={props.brief.instruction}>
        <div class="mt-2 font-mono text-[11px] text-muted-foreground">Instruction</div>
        <p class="mt-0.5">{props.brief.instruction}</p>
      </Show>
    </>
  )
}

function Frame(props: {
  id: string | number
  title: string
  icon?: JSX.Element
  link: JSX.Element
  children: JSX.Element
}) {
  return (
    <Card data-side-chat-handoff={props.id}>
      <header class="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        {props.icon ?? <GitForkIcon class="size-3.5 text-brand" />}
        <span class="shrink-0 whitespace-nowrap text-foreground">Side chat</span>
        <span>handoff</span>
        <span class="truncate text-foreground">{props.title}</span>
        {props.link}
      </header>
      <div class="min-w-0 px-3 py-2.5 text-[13px] leading-relaxed">{props.children}</div>
    </Card>
  )
}

function OpenLink(props: { to: ConversationId; label: string; text: string }) {
  return (
    <Button
      aria-label={props.label}
      class="ml-auto flex gap-1 rounded-none font-mono text-[11px] font-normal hover:text-foreground"
      onClick={() => {
        showSurface('agent')
        switchConversation(props.to)
      }}
      size={null}
      title={props.label}
      variant={null}
    >
      <SquareArrowOutUpRightIcon class="size-3" />
      {props.text}
    </Button>
  )
}

export function HandoffCard(props: { entry: EntryRecord & { data: SideChatHandoff } }) {
  const data = () => props.entry.data
  return (
    <Frame
      id={props.entry.id}
      link={
        <OpenLink
          label={`Read side chat #${data().from} from handoff #${props.entry.id}`}
          text="side chat"
          to={data().from}
        />
      }
      title={data().title}
    >
      <p>{data().outcome}</p>
      <Details brief={data()} />
      <Show when={data().words?.length}>
        <Collapsible class="group/side-chat-words mt-2">
          <CollapsibleTrigger
            aria-label={`Your words in handoff #${props.entry.id}`}
            class="flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
          >
            <ChevronRight class="size-3 transition-transform group-data-open/side-chat-words:rotate-90" />
            Your words · {data().words!.length}
            {data().earlier ? ` (${data().earlier} earlier left out)` : ''}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <For each={data().words}>
              {(said) => (
                <blockquote class="mt-1 border-l-2 border-border pl-2 whitespace-pre-wrap text-muted-foreground">
                  {said}
                </blockquote>
              )}
            </For>
          </CollapsibleContent>
        </Collapsible>
      </Show>
    </Frame>
  )
}

export function HandoffCall(props: { call: ToolCallView; core: JSX.Element }) {
  const fork = useDocOf(useConversationId(), SideChatForkDoc)
  const brief = () => props.call.args as Partial<Brief> & { to?: number }
  const place = useContext(ConversationScope) === null ? 'in the transcript' : 'in the side chat'
  const target = () => (brief().to as ConversationId | undefined) ?? fork()?.of
  const targetName = useSourceName(target)
  const where = () => targetName() ?? 'the source'
  const failed = () => props.call.status === 'error'
  const sent = () => props.call.status === 'done'
  const error = () =>
    [props.call.output, ...props.call.diagnostics.map((d) => d.message)].filter(Boolean).join('\n')
  return (
    <Show fallback={props.core} when={props.call.status !== 'interrupted' && brief().title}>
      {(title) => (
        <Frame
          icon={sent() ? undefined : <ToolStatusIcon state={props.call.status} />}
          id={props.call.id}
          link={
            <Show
              fallback={<span class="ml-auto">{failed() ? 'not sent' : `to ${where()}`}</span>}
              when={sent() && target()}
            >
              {(to) => (
                <OpenLink
                  label={`Open ${where()} that handoff ${props.call.id} went to, ${place}`}
                  text={`sent to ${where()}`}
                  to={to()}
                />
              )}
            </Show>
          }
          title={title()}
        >
          <Show when={failed() && error()}>
            <p class="mb-1.5 font-mono text-[11px] break-words whitespace-pre-wrap text-error">
              {error()}
            </p>
          </Show>
          <p>{brief().outcome}</p>
          <Collapsible class="group/side-chat-brief mt-2">
            <CollapsibleTrigger
              aria-label={`Brief of handoff ${props.call.id}, ${place}`}
              class="flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
            >
              <ChevronRight class="size-3 transition-transform group-data-open/side-chat-brief:rotate-90" />
              Brief
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Details brief={brief()} />
            </CollapsibleContent>
          </Collapsible>
        </Frame>
      )}
    </Show>
  )
}

export function SummaryCard(props: { entry: EntryRecord & { data: SideChatSummary } }) {
  const data = () => props.entry.data
  return (
    <Card data-side-chat-summary={props.entry.id}>
      <Collapsible class="group/side-chat-summary">
        <header class="flex items-center gap-2 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          <CollapsibleTrigger
            aria-label={`Summary of side chat #${data().from}`}
            class="flex min-w-0 items-center gap-2 hover:text-foreground"
          >
            <ChevronRight class="size-3 shrink-0 transition-transform group-data-open/side-chat-summary:rotate-90" />
            <GitForkIcon class="size-3.5 shrink-0 text-brand" />
            <span class="shrink-0 whitespace-nowrap text-foreground">Side chat</span>
            <span>summary</span>
            <span class="truncate">
              {data().startedAt ? `${formatTime(data().startedAt!)}–` : ''}
              {formatTime(data().endedAt)} ·{' '}
              {closingReason(data().reason ?? 'quiet', QUIET_MINUTES)}
            </span>
          </CollapsibleTrigger>
          <OpenLink
            label={`Read side chat #${data().from} from summary #${props.entry.id}`}
            text="side chat"
            to={data().from}
          />
        </header>
        <CollapsibleContent>
          <div class="min-w-0 border-t border-border/60 px-3 py-2.5 text-[13px] leading-relaxed">
            <Markdown text={data().text} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}

export function LegacySummaryCard(props: {
  entry: EntryRecord & { data: { side: ConversationId; text: string } }
}) {
  const side = () => props.entry.data.side
  return (
    <Card data-side-chat-summary={props.entry.id}>
      <header class="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <GitForkIcon class="size-3.5 text-brand" />
        <span class="text-foreground">Side chat</span>
        <span>summary</span>
        <OpenLink
          label={`Read side chat #${side()} from summary #${props.entry.id}`}
          text="side chat"
          to={side()}
        />
      </header>
      <div class="min-w-0 px-3 py-3 text-[13px] leading-relaxed">
        <Markdown text={props.entry.data.text} />
      </div>
    </Card>
  )
}
