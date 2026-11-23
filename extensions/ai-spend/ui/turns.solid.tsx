import { ArrowUpRightIcon } from '@lucide/solid'
import { For, Show, createMemo, createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { cn } from '@/sdk/solid'
import { CACHE } from '../model/dimensions.ts'
import { count, dateLabel, usd } from '../model/format.ts'
import type { Turn } from '../model/turns.ts'
import { refOf } from '../model/types.ts'
import type { Row } from '../model/types.ts'
import { openConversation } from './breakdown.solid.tsx'
import { SortHead, sorted, useSort } from './sort.solid.tsx'
import type { Columns } from './sort.solid.tsx'

const FIRST = 5
const GRID =
  'grid grid-cols-[4.75rem_minmax(0,1fr)] items-center gap-x-3 @3xl:grid-cols-[4.75rem_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,0.7fr)_3.5rem_6.5rem]'

const pause = (ms: number) => {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  if (minutes < 10 * 60) return `${(minutes / 60).toFixed(1).replace(/\.0$/, '')} h`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`
  return `${Math.round(minutes / 1440)} days`
}

const clock = (at: number) => {
  const date = new Date(at)
  return `${dateLabel(at)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function reason(turn: Turn): { text: string; leaked: boolean } {
  const { row } = turn
  const leaked = turn.leakUsd > 0
  if (turn.cache === CACHE.idle)
    return { text: `idle rewrite after ${row.gapMs ? pause(row.gapMs) : 'a pause'}`, leaked }
  if (turn.cache === CACHE.other)
    return {
      text: row.gapMs === undefined ? 'first prompt, no cache yet' : 'prompt changed, rewritten',
      leaked,
    }
  if (turn.cache === CACHE.miss) return { text: 'implicit cache miss', leaked }
  const { input, output, cacheRead, cacheWrite } = row.cost
  const most = Math.max(input, output, cacheRead, cacheWrite)
  if (output === most)
    return { text: `mostly output, ${count(row.tokens.output)} tokens`, leaked: false }
  if (cacheRead === most) return { text: 'mostly cache reads', leaked: false }
  return { text: cacheWrite === most ? 'mostly cache writes' : 'mostly plain input', leaked: false }
}

const modelOf = (row: Row) =>
  row.served ? `${row.served.split('/').pop()} via ${row.model}` : row.model

type TurnColumn = 'spend' | 'why' | 'conversation' | 'model' | 'prompt' | 'when'
const COLUMNS: Columns<TurnColumn, Turn> = {
  spend: { value: (turn) => turn.usd },
  why: { value: (turn) => reason(turn).text },
  conversation: { value: (turn) => turn.conversation.title },
  model: { value: (turn) => modelOf(turn.row) },
  prompt: { value: (turn) => turn.prompt },
  when: { value: (turn) => turn.row.at },
}

const turnKey = (turn: Turn) => `${turn.row.conversation}:${turn.row.at}`

export function TurnList(props: { turns: Turn[] }) {
  const [all, setAll] = createSignal(false)
  const { sort, onSort } = useSort<TurnColumn>()
  const ordered = createMemo(() => sorted(props.turns, sort(), COLUMNS))
  const shown = () => (all() ? ordered() : ordered().slice(0, FIRST))
  return (
    <Show
      when={props.turns.length}
      fallback={
        <p class="py-6 pl-2 font-mono text-[11.5px] text-muted-foreground/70">
          No responses in this range.
        </p>
      }
    >
      <div class="flex flex-col">
        <div
          class={cn(
            GRID,
            'h-7 border-b border-border/60 px-2 font-mono text-[10.5px] text-muted-foreground/70',
          )}
        >
          <SortHead column="spend" onSort={onSort} right sort={sort()} table="turns">
            spend
          </SortHead>
          <SortHead
            class="hidden @3xl:block"
            column="why"
            onSort={onSort}
            sort={sort()}
            table="turns"
            text
          >
            why
          </SortHead>
          <SortHead
            class="@3xl:hidden"
            column="why"
            onSort={onSort}
            sort={sort()}
            table="turns by reason"
            text
          >
            why · conversation
          </SortHead>
          <SortHead
            class="hidden @3xl:block"
            column="conversation"
            onSort={onSort}
            sort={sort()}
            table="turns"
            text
          >
            conversation
          </SortHead>
          <SortHead
            class="hidden @3xl:block"
            column="model"
            onSort={onSort}
            sort={sort()}
            table="turns"
            text
          >
            model
          </SortHead>
          <SortHead
            class="hidden @3xl:block"
            column="prompt"
            onSort={onSort}
            right
            sort={sort()}
            table="turns"
            title="Input, cache read and cache write tokens"
          >
            prompt
          </SortHead>
          <SortHead
            class="hidden @3xl:block"
            column="when"
            onSort={onSort}
            right
            sort={sort()}
            table="turns"
          >
            when
          </SortHead>
        </div>
        <div class="flex flex-col pt-1">
          <For each={shown()} keyed={turnKey}>
            {(turn) => <TurnRow turn={turn()} />}
          </For>
        </div>
        <Show when={props.turns.length > FIRST}>
          <Button
            aria-label={
              all() ? `Show the first ${FIRST} turns` : `Show ${props.turns.length} turns`
            }
            class="mt-1 h-7 self-start rounded-md px-2 font-mono text-[10.5px] font-normal text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => setAll(!all())}
            size={null}
            variant={null}
          >
            {all() ? `show the first ${FIRST}` : `show ${props.turns.length}`}
          </Button>
        </Show>
      </div>
    </Show>
  )
}

function TurnRow(props: { turn: Turn }) {
  const row = () => props.turn.row
  const conversation = () => props.turn.conversation
  const why = createMemo(() => reason(props.turn))
  const model = () => modelOf(row())
  const when = () => clock(row().at)
  const live = () => conversation().live
  return (
    <Button
      aria-label={`Open ${refOf(conversation())} at its ${usd(props.turn.usd)} turn of ${when()}`}
      class={cn(
        GRID,
        'group/row h-auto min-h-8 justify-stretch gap-y-0 rounded-md px-2 py-1.5 text-left font-mono text-[11.5px] font-normal whitespace-normal text-foreground/85 tabular-nums outline-none hover:bg-muted/40 focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-auto disabled:opacity-100 data-disabled:opacity-100 disabled:hover:bg-transparent @3xl:py-0',
      )}
      data-spend-turn
      disabled={!live()}
      onClick={() => openConversation(conversation())}
      size={null}
      title={`${usd(props.turn.usd)} · ${why().text}${props.turn.leakUsd > 0 ? ` · ${usd(props.turn.leakUsd)} of it a warm cache would have saved` : ''}\n${row().provider}/${row().model}${row().served ? ` → ${row().served}` : ''} · ${count(props.turn.prompt)} prompt · ${when()}\n${live() ? `Open ${refOf(conversation())}` : 'In an earlier chapter: only its costs are kept'}`}
      variant={null}
    >
      <span class="self-start text-right text-foreground @3xl:self-center">
        {usd(props.turn.usd)}
      </span>
      <span class="flex min-w-0 flex-col @3xl:contents">
        <span class="flex min-w-0 items-center gap-1.5">
          <span
            class={cn(
              'size-1.5 shrink-0 rounded-full',
              why().leaked ? 'bg-warning' : 'bg-transparent',
            )}
          />
          <span class="truncate">{why().text}</span>
        </span>
        <span class="flex min-w-0 items-center gap-1.5 pl-3 @3xl:pl-0">
          <span class="min-w-0 truncate font-sans text-[12.5px] text-foreground/90 group-hover/row:text-foreground">
            {conversation().title}
          </span>
          <span class="max-w-[40%] shrink-0 truncate text-[10.5px] text-muted-foreground/70">
            {refOf(conversation())}
          </span>
          <ArrowUpRightIcon
            class={cn(
              'size-3 shrink-0 text-muted-foreground opacity-0 group-hover/row:opacity-100',
              !live() && 'hidden',
            )}
          />
        </span>
        <span class="truncate pl-3 text-[10.5px] text-muted-foreground @3xl:hidden">
          {model()} · {count(props.turn.prompt)} prompt · {when()}
        </span>
        <span class="hidden truncate text-muted-foreground @3xl:block">{model()}</span>
        <span class="hidden text-right text-muted-foreground @3xl:block">
          {count(props.turn.prompt)}
        </span>
        <span class="hidden text-right text-muted-foreground @3xl:block">{when()}</span>
      </span>
    </Button>
  )
}
