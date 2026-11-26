import type { ConversationId } from '@earendil-works/pi-durable'
import { AudioLinesIcon, ChevronRight, SquareArrowOutUpRightIcon } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { For, Show, useContext } from 'solid-js'
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
  renderEntry,
  showSurface,
  switchConversation,
  useConversationId,
  useDocOf,
  type ToolCallView,
} from '@/sdk/solid'
import { VoiceHandoffEntry } from './entries.ts'
import { VoiceForkDoc, type VoiceHandoff } from './refs.ts'

type Brief = Omit<VoiceHandoff, 'from'>

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
    <Card data-voice-handoff={props.id}>
      <header class="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        {props.icon ?? <AudioLinesIcon class="size-3.5 text-brand" />}
        <span class="text-foreground">Voice</span>
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

export const HandoffCard = renderEntry(VoiceHandoffEntry, function HandoffCard(props) {
  const data = () => props.entry.data
  return (
    <Frame
      id={props.entry.id}
      link={
        <OpenLink
          label={`Read voice session #${data().from} from handoff #${props.entry.id}`}
          text="voice session"
          to={data().from}
        />
      }
      title={data().title}
    >
      <p>{data().outcome}</p>
      <Details brief={data()} />
      <Show when={data().words?.length}>
        <Collapsible class="group/voice-words mt-2">
          <CollapsibleTrigger
            aria-label={`Your words in handoff #${props.entry.id}`}
            class="flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
          >
            <ChevronRight class="size-3 transition-transform group-data-open/voice-words:rotate-90" />
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
})

export function HandoffCall(props: { call: ToolCallView; core: JSX.Element }) {
  const fork = useDocOf(useConversationId(), VoiceForkDoc)
  const brief = () => props.call.args as Partial<Brief> & { to?: number }
  const place = useContext(ConversationScope) === null ? 'in the transcript' : 'in the voice dock'
  const target = () => (brief().to as ConversationId | undefined) ?? fork()?.of
  const where = () => (brief().to === undefined ? '@ultimate' : `#${brief().to}`)
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
          <Collapsible class="group/voice-brief mt-2">
            <CollapsibleTrigger
              aria-label={`Brief of handoff ${props.call.id}, ${place}`}
              class="flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
            >
              <ChevronRight class="size-3 transition-transform group-data-open/voice-brief:rotate-90" />
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
