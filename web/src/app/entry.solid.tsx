import { CompactionEntry } from '@earendil-works/pi-durable'
import type { EntryRecord, ToolSlot } from '@earendil-works/pi-durable'
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai'
import { Check, ChevronRight, CircleAlert, CircleStop } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { createMemo, For, Match, Show, Switch } from 'solid-js'

import { Message } from '@/components/ai/message.solid.tsx'
import { Reasoning } from '@/components/ai/reasoning.solid.tsx'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import { AnswerSpeaker, entryRenderers, messageItems, useExtensions } from '../sdk/hooks.ts'
import { Contributed, Contribution, RenderedPoint } from '../sdk/contribution.solid.tsx'
import { ContributionError } from './contribution-error.solid.tsx'
import { MessageActions } from './message-actions.solid.tsx'
import { callsStart, toolCallView } from './model.ts'
import type { ToolResult } from './model.ts'
import { ToolCallBlock } from './tool-call.solid.tsx'
import { textOf } from './user-text.ts'
import { UserView } from './user-turn.solid.tsx'

export function EntryView(props: {
  entry: EntryRecord
  blocks?: readonly number[]
  results: Map<string, ToolResult>
  slots: Map<string, ToolSlot>
  busy: boolean
}) {
  const extensions = useExtensions()
  const renderers = createMemo(() => entryRenderers(extensions(), props.entry.kind))
  return (
    <Contributed
      core={() => (
        <CoreEntry
          blocks={props.blocks}
          busy={props.busy}
          entry={props.entry}
          results={props.results}
          slots={props.slots}
        />
      )}
      fallback={(extension, error, inner) => (
        <ContributionError error={error} extension={extension}>
          {inner()}
        </ContributionError>
      )}
      props={{
        get entry() {
          return props.entry
        },
        get blocks() {
          return props.blocks
        },
      }}
      renderers={renderers()}
    />
  )
}

function CoreEntry(props: {
  entry: EntryRecord
  blocks?: readonly number[]
  results: Map<string, ToolResult>
  slots: Map<string, ToolSlot>
  busy: boolean
}) {
  const message = () => props.entry.model?.[0]
  return (
    <Switch fallback={<UnknownEntry entry={props.entry} />}>
      <Match when={props.entry.kind === 'pi.user'}>
        <Show when={message()?.role === 'user' ? message() : undefined}>
          {(user) => (
            <UserView
              entry={props.entry}
              message={user() as Extract<ReturnType<typeof message>, { role: 'user' }>}
            />
          )}
        </Show>
      </Match>
      <Match when={props.entry.kind === 'pi.assistant'}>
        <Show when={message()?.role === 'assistant' ? (message() as AssistantMessage) : undefined}>
          {(assistant) => (
            <AssistantView
              blocks={props.blocks}
              busy={props.busy}
              entry={props.entry}
              message={assistant()}
              results={props.results}
              slots={props.slots}
            />
          )}
        </Show>
      </Match>
      <Match when={props.entry.kind === 'pi.system'}>
        <Show when={message()?.role === 'system'}>
          <Divider>system prompt changed</Divider>
        </Show>
      </Match>
      <Match when={props.entry.kind === 'pi.compaction'}>
        <CompactionView entry={props.entry} />
      </Match>
      <Match when={props.entry.kind === 'pi.reset'}>
        <Divider>context reset{message()?.role === 'user' ? ' · handoff' : ''}</Divider>
      </Match>
      <Match when={props.entry.kind === 'pi.tool-result'}>
        <Show when={message()?.role === 'toolResult' ? message() : undefined}>
          {(result) => {
            const value = () =>
              result() as Extract<ReturnType<typeof message>, { role: 'toolResult' }>
            const view = createCallView(() => ({
              call: {
                type: 'toolCall',
                id: value().toolCallId,
                name: value().toolName,
                arguments: {},
              },
              result: props.results.get(value().toolCallId),
              streaming: false,
              busy: props.busy,
            }))
            return <ToolCallBlock call={view()} />
          }}
        </Show>
      </Match>
    </Switch>
  )
}

function FinalAnswerHeading() {
  return (
    <span class="inline-flex items-center gap-1.5 text-success">
      <Check aria-hidden="true" class="size-3.5" /> Final answer
    </span>
  )
}

export function AssistantView(props: {
  entry?: EntryRecord
  message: AssistantMessage
  blocks?: readonly number[]
  results: Map<string, ToolResult>
  slots: Map<string, ToolSlot>
  busy: boolean
  streaming?: boolean
}) {
  const extensions = useExtensions()
  const labels = createMemo(() => messageItems(extensions(), 'answerLabels'))
  const streaming = () => props.streaming ?? false
  const last = () => props.message.content.length - 1
  const final = createMemo(
    () =>
      !streaming() &&
      props.message.stopReason === 'stop' &&
      !props.message.content.some((block) => block.type === 'toolCall') &&
      props.message.content.some((block) => block.type === 'text' && block.text.trim()),
  )
  const ended = () => !streaming() && props.message.stopReason !== 'toolUse'
  const ownsNoticeAndActions = () => !props.blocks || props.blocks.includes(last())
  const text = createMemo(() =>
    props.message.content
      .flatMap((block) => (block.type === 'text' && block.text.trim() ? [block.text] : []))
      .join('\n\n'),
  )
  const shown = (index: number) => !props.blocks || props.blocks.includes(index)
  const answerLabels = (entry: EntryRecord) => (
    <For each={labels()} keyed={(item) => item.key}>
      {(item) => (
        <Contribution
          fallback={(extension, error) => (
            <ContributionError error={error} extension={extension} inline />
          )}
          item={item()}
          props={{ entry }}
        />
      )}
    </For>
  )
  const cutOff = () =>
    !streaming() && props.message.stopReason === 'length' && ownsNoticeAndActions()
  return (
    <Message class="group/message gap-3" data-final={final() || undefined} from="assistant">
      <Show when={final()}>
        <div class="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px]">
          <Show when={props.entry} fallback={<FinalAnswerHeading />}>
            {(entry) => (
              <>
                <RenderedPoint
                  core={() => <FinalAnswerHeading />}
                  fallback={(extension, error, inner) => (
                    <ContributionError error={error} extension={extension} inline>
                      {inner()}
                    </ContributionError>
                  )}
                  input={{ entry: entry() }}
                  point={AnswerSpeaker}
                />
                {answerLabels(entry())}
              </>
            )}
          </Show>
        </div>
      </Show>
      <Show when={cutOff() ? props.entry : undefined}>
        {(entry) => (
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] empty:hidden">
            {answerLabels(entry())}
          </div>
        )}
      </Show>
      <For each={props.message.content} keyed={false}>
        {(block, index) => (
          <Show when={shown(index)}>
            <Switch>
              <Match
                when={
                  block().type === 'thinking' &&
                  (block() as { thinking: string; redacted?: boolean })
                }
              >
                {(thinking) => (
                  <Show when={thinking().thinking || thinking().redacted}>
                    <Reasoning
                      label={`${streaming() && index === last() ? 'Thinking' : 'Thought'}${thinking().redacted ? ' (redacted)' : ''}`}
                      streaming={streaming() && index === last()}
                    >
                      {thinking().thinking}
                    </Reasoning>
                  </Show>
                )}
              </Match>
              <Match when={block().type === 'text' && (block() as { text: string }).text}>
                {(words) => <Markdown streaming={streaming() && index === last()} text={words()} />}
              </Match>
              <Match when={block().type === 'toolCall' && (block() as ToolCall)}>
                {(call) => {
                  const view = createCallView(() => ({
                    call: call(),
                    result: props.results.get(call().id),
                    slot: props.slots.get(call().id),
                    streaming: streaming(),
                    busy: props.busy,
                    startedAt: streaming() ? undefined : callsStart(props.message),
                  }))
                  return <ToolCallBlock call={view()} />
                }}
              </Match>
            </Switch>
          </Show>
        )}
      </For>
      <Show
        when={
          ownsNoticeAndActions() &&
          !streaming() &&
          (props.message.stopReason !== 'toolUse' || props.message.errorMessage)
        }
      >
        <AssistantNotice message={props.message} />
      </Show>
      <Show when={ownsNoticeAndActions() && (text() || ended()) ? props.entry : undefined}>
        {(entry) => (
          <MessageActions entry={entry()} text={text()} timestamp={props.message.timestamp} />
        )}
      </Show>
    </Message>
  )
}

function AssistantNotice(props: { message: AssistantMessage }) {
  return (
    <Switch>
      <Match when={props.message.stopReason === 'error'}>
        <div class="font-mono text-[11px]">
          <div class="flex items-start gap-1.5 text-error">
            <CircleAlert aria-hidden="true" class="mt-0.5 size-3.5 shrink-0" />
            <span class="min-w-0 break-words">
              {props.message.errorMessage ?? 'The provider returned an error'}
            </span>
          </div>
        </div>
      </Match>
      <Match when={props.message.stopReason === 'aborted'}>
        <div class="font-mono text-[11px]">
          <div class="flex items-center gap-1.5 text-muted-foreground">
            <CircleStop aria-hidden="true" class="size-3.5" /> aborted
          </div>
        </div>
      </Match>
      <Match when={props.message.stopReason === 'length'}>
        <div class="font-mono text-[11px]">
          <div class="flex items-center gap-1.5 text-warning">
            <CircleAlert aria-hidden="true" class="size-3.5" /> stopped at the output limit
          </div>
        </div>
      </Match>
    </Switch>
  )
}

function Divider(props: { children: JSX.Element }) {
  return (
    <div
      class="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/70 before:h-px before:flex-1 before:bg-border/70 after:h-px after:flex-1 after:bg-border/70"
      data-ui="transcript-meta"
    >
      {props.children}
    </div>
  )
}

function CompactionView(props: { entry: EntryRecord }) {
  const summary = createMemo(() => {
    const message = props.entry.model?.[0]
    const wrapped = message?.role === 'user' ? textOf(message.content) : ''
    const start = wrapped.indexOf('<summary>\n')
    const end = wrapped.lastIndexOf('\n</summary>')
    return start >= 0 && end > start ? wrapped.slice(start + '<summary>\n'.length, end) : wrapped
  })
  const reason = () => (CompactionEntry.is(props.entry) ? props.entry.data?.reason : undefined)
  return (
    <Collapsible class="group/compaction rounded-lg border border-brand/30 bg-brand/5">
      <CollapsibleTrigger class="flex w-full flex-col gap-1 px-3.5 py-2.5 text-left">
        <span class="flex items-center gap-1.5 font-mono text-[11px] text-brand">
          <ChevronRight
            aria-hidden="true"
            class="size-3.5 transition-transform group-data-open/compaction:rotate-90"
          />
          Conversation condensed{reason() ? ` · ${reason()}` : ''}
        </span>
        <span class="text-xs text-muted-foreground">
          Prior conversation was condensed into a summary. Earlier messages remain available above.
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent class="border-t border-brand/20 px-3.5 py-2.5 text-[13px]">
        <Markdown text={summary()} />
      </CollapsibleContent>
    </Collapsible>
  )
}

function UnknownEntry(props: { entry: EntryRecord }) {
  return (
    <Collapsible class="group/unknown rounded-md border border-dashed border-border font-mono text-[11.5px]">
      <CollapsibleTrigger class="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-muted-foreground">
        <ChevronRight
          aria-hidden="true"
          class="size-3 transition-transform group-data-open/unknown:rotate-90"
        />
        {props.entry.kind}
        <span class="text-muted-foreground/60">#{props.entry.id}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre class="max-h-64 overflow-auto border-t border-dashed px-2.5 py-2 text-muted-foreground">
          {JSON.stringify({ data: props.entry.data, model: props.entry.model }, null, 2)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

type CallInputs = {
  call: ToolCall
  result?: ToolResult
  slot?: ToolSlot
  streaming: boolean
  busy: boolean
  startedAt?: number
}

const sameCall = (a: CallInputs, b: CallInputs) =>
  a.call.id === b.call.id &&
  a.call.name === b.call.name &&
  a.call.arguments === b.call.arguments &&
  a.result?.message === b.result?.message &&
  a.slot === b.slot &&
  a.streaming === b.streaming &&
  a.startedAt === b.startedAt &&
  (a.result !== undefined || a.busy === b.busy)

function createCallView(inputs: () => CallInputs) {
  const current = createMemo(inputs, { equals: sameCall })
  return createMemo(() => {
    const { call, ...context } = current()
    return toolCallView(call, context)
  })
}
