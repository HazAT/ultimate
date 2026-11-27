import type { ConversationId, ToolSlot } from '@earendil-works/pi-durable'
import type { ToolCall } from '@earendil-works/pi-ai'
import { ChevronRight } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import { createMemo, For, Show } from 'solid-js'

import { ToolStatusIcon } from '@/components/ai/tool.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import { toolLine, useExtensions } from '../sdk/hooks.ts'
import { Contribution } from '../sdk/contribution.solid.tsx'
import { partKey, partsOf } from './compact.ts'
import type { AsideGroup, BetweenGroup, CompactPart, WorkRun } from './compact.ts'
import { ContributionError } from './contribution-error.solid.tsx'
import { EntryView } from './entry.solid.tsx'
import { foldKey, readFold, writeFold } from './fold-state.ts'
import { callsStart, toolCallView } from './model.ts'
import type { ToolResult } from './model.ts'

export type Row = CompactPart | WorkRun
export type Item = Row | AsideGroup
export type Shown = Item | BetweenGroup<Item>

export const recedeRow =
  '-mt-1.5 opacity-45 transition-opacity duration-200 hover:opacity-100 focus-within:opacity-100'

export const itemParts = (item: Item) =>
  'aside' in item ? item.aside.flatMap(partsOf) : partsOf(item)
const partKeyOf = (row: Row) => partKey(partsOf(row)[0])
export const itemKey = (item: Item) =>
  'aside' in item ? `aside:${asideFirstEntryKey(item)}` : partKeyOf(item)
export const shownKey = (item: Shown) =>
  'between' in item ? `between:${partKey(itemParts(item.between[0])[0])}` : itemKey(item)

const betweenEndpointKeys = (id: ConversationId | undefined, group: BetweenGroup<Item>) => {
  const parts = group.between.flatMap(itemParts)
  return [parts[0], parts.at(-1)!].map((part) => foldKey(id, `between:${partKey(part)}`))
}
export const readBetween = (id: ConversationId | undefined, group: BetweenGroup<Item>) =>
  betweenEndpointKeys(id, group).some(readFold)
export const writeBetween = (
  id: ConversationId | undefined,
  group: BetweenGroup<Item>,
  open: boolean,
) => {
  for (const key of betweenEndpointKeys(id, group)) writeFold(key, open)
}

export function BetweenLine(props: {
  group: BetweenGroup<Item>
  open: boolean
  onOpen: () => void
  working: boolean
  summary: { extension: string; version: number; component: unknown } | undefined
}) {
  const flat = () => props.group.between.flatMap((row) => ('aside' in row ? row.aside : [row]))
  const rows = createMemo(() =>
    flat().flatMap((row) => ('work' in row ? [] : [{ entry: row.entry, calls: shownCalls(row) }])),
  )
  const steps = () =>
    props.group.between.reduce((sum, row) => sum + ('work' in row ? row.steps : 0), 0)
  const entries = createMemo(() =>
    flat()
      .flatMap((row) => ('work' in row ? row.work : [row]))
      .map((part) => part.entry),
  )
  const fallback = () => <>{rows().length} updates</>
  return (
    <Button
      aria-expanded={props.open ? 'true' : 'false'}
      class="my-1 flex h-auto w-full min-w-0 justify-start gap-3 rounded-none p-0 font-mono text-[11px] font-normal text-muted-foreground/60 before:h-px before:w-6 before:shrink-0 before:bg-border/60 after:h-px after:flex-1 after:bg-border/60 hover:text-muted-foreground"
      data-between={rows().length}
      onClick={() => props.onOpen()}
      size={null}
      variant={null}
    >
      <span class="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
        <Show when={props.summary} fallback={fallback()}>
          {(summary) => (
            <Contribution
              fallback={(extension, error) => (
                <ContributionError error={error} extension={extension} inline>
                  {fallback()}
                </ContributionError>
              )}
              item={summary()}
              props={{
                get entries() {
                  return entries()
                },
                get rows() {
                  return rows()
                },
                get steps() {
                  return steps()
                },
                get working() {
                  return props.working
                },
              }}
            />
          )}
        </Show>
        <ChevronRight
          aria-hidden="true"
          class={cn('size-3 shrink-0 transition-transform', props.open && 'rotate-90')}
        />
      </span>
    </Button>
  )
}

export const asideFirstEntryKey = (group: AsideGroup) => partsOf(group.aside[0])[0].entry.id

export function AsideFold(props: {
  group: AsideGroup
  open: boolean
  onOpenChange: (open: boolean) => void
  faded?: string
  Row: (props: { row: Row }) => JSX.Element
}) {
  return (
    <Collapsible
      class={cn('group/aside', props.faded)}
      data-set-aside={props.group.steps}
      onOpenChange={(open) => props.onOpenChange(open)}
      open={props.open}
    >
      <CollapsibleTrigger
        class="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground/70 hover:text-muted-foreground"
        data-ui="transcript-meta"
      >
        {props.group.steps} step{props.group.steps === 1 ? '' : 's'} set aside ·{' '}
        {props.open ? 'hide' : 'show'}
        <ChevronRight
          aria-hidden="true"
          class="size-3 transition-transform group-data-open/aside:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        class="mt-3 flex flex-col gap-3 border-l border-dashed border-border/70 pl-3 opacity-70"
        data-ui="transcript-steps"
      >
        <For each={props.group.aside} keyed={partKeyOf}>
          {(inner) => <props.Row row={inner()} />}
        </For>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function shownCalls({ entry, blocks }: CompactPart): ToolCall[] {
  const message = entry.model?.[0]
  if (message?.role !== 'assistant') return []
  return message.content.flatMap((block, index) =>
    block.type === 'toolCall' && (!blocks || blocks.includes(index)) ? [block] : [],
  )
}

export function WorkRow(props: {
  run: WorkRun
  working: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  results: Map<string, ToolResult>
  slots: Map<string, ToolSlot>
  busy: boolean
}) {
  return (
    <Collapsible
      class="group/work"
      onOpenChange={(open) => props.onOpenChange(open)}
      open={props.open}
    >
      <CollapsibleTrigger
        class="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground/70 hover:text-muted-foreground"
        data-ui="transcript-meta"
      >
        {props.working ? 'working' : 'worked'} · {props.run.steps} step
        {props.run.steps === 1 ? '' : 's'}
        <ChevronRight
          aria-hidden="true"
          class="size-3 transition-transform group-data-open/work:rotate-90"
        />
      </CollapsibleTrigger>
      <Show when={!props.open}>
        <StepLines
          busy={props.busy}
          onOpen={() => props.onOpenChange(true)}
          results={props.results}
          run={props.run}
          slots={props.slots}
        />
      </Show>
      <CollapsibleContent
        class="mt-3 flex flex-col gap-3 border-l border-border/70 pl-3"
        data-ui="transcript-steps"
      >
        <For each={props.run.work} keyed={partKey}>
          {(part) => (
            <div class="empty-row" data-entry-id={part().entry.id}>
              <EntryView
                blocks={part().blocks}
                busy={props.busy}
                entry={part().entry}
                results={props.results}
                slots={props.slots}
              />
            </div>
          )}
        </For>
      </CollapsibleContent>
    </Collapsible>
  )
}

function runCalls(run: WorkRun): { block: ToolCall; startedAt: number }[] {
  return run.work.flatMap(({ entry, blocks }) => {
    const message = entry.model?.[0]
    if (message?.role !== 'assistant') return []
    const startedAt = callsStart(message)
    return message.content.flatMap((block, index) =>
      block.type === 'toolCall' && (!blocks || blocks.includes(index))
        ? [{ block, startedAt }]
        : [],
    )
  })
}

const NEWEST_STEP_LINE_LIMIT = 8

function StepLines(props: {
  run: WorkRun
  results: Map<string, ToolResult>
  slots: Map<string, ToolSlot>
  busy: boolean
  onOpen: () => void
}) {
  const extensions = useExtensions()
  const calls = createMemo(() => runCalls(props.run))
  const shown = createMemo(() =>
    calls()
      .slice(-NEWEST_STEP_LINE_LIMIT)
      .map(({ block, startedAt }) =>
        toolCallView(block, {
          result: props.results.get(block.id),
          slot: props.slots.get(block.id),
          streaming: false,
          busy: props.busy,
          startedAt,
        }),
      ),
  )
  return (
    <Show when={calls().length > 0}>
      <Button
        aria-label={`Open ${calls().length} calls run #${props.run.work[0].entry.id}`}
        class="mt-1.5 flex h-auto w-full min-w-0 flex-col items-stretch gap-0.5 rounded-none border-l border-border/70 py-0 pr-0 pl-3 text-left font-mono text-[11.5px] leading-[1.6] font-normal whitespace-normal text-muted-foreground hover:text-foreground/90"
        onClick={() => props.onOpen()}
        size={null}
        variant={null}
      >
        <Show when={calls().length > shown().length}>
          <span class="text-muted-foreground/60">+{calls().length - shown().length} earlier</span>
        </Show>
        <For each={shown()} keyed={(call) => call.id}>
          {(call) => {
            const line = createMemo(() => toolLine(extensions(), call().name))
            return (
              <span class="flex min-w-0 items-center gap-2">
                <ToolStatusIcon class="size-3" state={call().status} />
                <span class="min-w-0 flex-1 truncate">
                  <Show when={line()} fallback={call().name}>
                    {(item) => (
                      <Contribution
                        fallback={(extension, error) => (
                          <ContributionError error={error} extension={extension} inline>
                            {call().name}
                          </ContributionError>
                        )}
                        item={item()}
                        props={{
                          get call() {
                            return call()
                          },
                        }}
                      />
                    )}
                  </Show>
                </span>
              </span>
            )
          }}
        </For>
      </Button>
    </Show>
  )
}
