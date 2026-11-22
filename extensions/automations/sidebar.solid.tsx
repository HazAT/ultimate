import { CalendarClock, ChevronRight, Radar, Zap } from '@lucide/solid'
import { Dynamic } from '@solidjs/web'
import { createMemo, createSignal, For, Show } from 'solid-js'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  api,
  cn,
  formatDuration,
  formatTime,
  openPanel,
  showSurface,
  switchConversation,
  useExtensionUiState,
  useNow,
} from '@/sdk/solid'
import {
  active,
  attention,
  countdown,
  automationKind,
  dotStatus,
  lookOf,
  looks,
  stateLine,
  worstFirst,
} from './looks.ts'
import type { Look } from './looks.ts'
import { openAutomation, openAutomationsPanel } from './navigation.ts'
import { useAutomations } from './live.solid.tsx'
import type { Automation } from './refs.ts'

const FIRST = 5
const shell = { openPanel, showSurface, switchConversation }

function short(automation: Automation, now: number) {
  const look = lookOf(automation, now)
  const last = automation.runs.at(-1)
  if (look === 'working' && last) return `working ${formatDuration(now - last.firedAt)}`
  if (look === 'watching') return automation.fires > 0 ? `fired ${automation.fires}` : 'watching'
  if (look === 'scheduled' && automation.nextAt !== undefined)
    return countdown(automation.nextAt, now)
  return looks[look].word
}

export function AutomationsSection() {
  const polled = useAutomations(() => 5000)
  const now = useNow(10_000)
  const expanded = useExtensionUiState('sidebarOpen', true)
  const [all, setAll] = createSignal(false)
  const list = createMemo(() => {
    const at = now()
    return worstFirst(
      (polled().data ?? []).filter((automation) => active(automation, at)),
      at,
    )
  })
  const failing = createMemo(() => {
    const at = now()
    return list().filter((automation) => attention(lookOf(automation, at))).length
  })
  return (
    <Show when={list().length > 0}>
      <Collapsible
        aria-label="Active automations"
        bind={expanded}
        class="mb-1 flex flex-col gap-px border-b border-border/60 pb-1"
        data-sidebar-section="automations"
      >
        <div class="mx-2 flex h-6 items-center gap-1">
          <CollapsibleTrigger class="group/automations flex h-6 items-center gap-1 rounded-md px-1 section-label outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">
            <ChevronRight class="size-3 transition-transform group-data-open/automations:rotate-90" />
            Active automations
          </CollapsibleTrigger>
          <Button
            aria-label={`${list().length} active${failing() ? `, ${failing()} need attention` : ''}: show all automations`}
            class={cn(
              'h-auto rounded-sm px-0.5 font-mono text-[11px] font-normal tabular-nums outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
              failing() ? 'text-error' : 'text-muted-foreground/60',
            )}
            data-automations-open
            onClick={() => openAutomationsPanel(shell)}
            title={
              failing()
                ? `${failing()} need attention · show all automations`
                : 'Show all automations'
            }
            size={null}
            variant={null}
          >
            {list().length}
          </Button>
        </div>
        <CollapsibleContent class="flex flex-col gap-px">
          <For each={all() ? list() : list().slice(0, FIRST)} keyed={(automation) => automation.id}>
            {(automation) => <Row automation={automation()} now={now()} />}
          </For>
          <Show when={list().length > FIRST}>
            <Button
              class="mx-2 h-5 justify-start rounded-md pl-[26px] text-left font-mono text-[10px] font-normal text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => setAll((on) => !on)}
              size={null}
              variant={null}
            >
              {all() ? 'fewer' : `+${list().length - FIRST} more`}
            </Button>
          </Show>
        </CollapsibleContent>
      </Collapsible>
    </Show>
  )
}

function Row(props: { automation: Automation; now: number }) {
  const look = createMemo(() => lookOf(props.automation, props.now))
  return (
    <Button
      class="group/row mx-2 flex h-7 min-w-0 justify-start gap-2 rounded-md pr-2 pl-2.5 text-left font-normal outline-none hover:bg-sidebar-accent/50 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
      data-sidebar-automation={props.automation.id}
      onClick={() => {
        const automation = props.automation
        if (automation.script) return openAutomation(automation.id, shell, api.action)
        const last = automation.runs.at(-1)
        const run =
          last?.status === 'running' || look() === 'failed' ? last?.conversationId : undefined
        if (run === undefined) return openAutomationsPanel(shell)
        showSurface('agent')
        switchConversation(run)
      }}
      size={null}
      title={`${props.automation.id} · ${props.automation.name}\n${looks[look()].word} · ${stateLine(props.automation, props.now, formatTime)}`}
      variant={null}
    >
      <Dot look={look()} />
      <span class="min-w-0 flex-1 truncate text-[12.5px] text-foreground/85">
        {props.automation.name}
      </span>
      <KindIcon automation={props.automation} />
      <span
        class={cn(
          'shrink-0 font-mono text-[10px] tabular-nums',
          look() === 'watching' || look() === 'scheduled'
            ? 'text-muted-foreground'
            : looks[look()].text,
        )}
      >
        {short(props.automation, props.now)}
      </span>
    </Button>
  )
}

function Dot(props: { look: Look }) {
  const appearance = () => looks[props.look]
  return (
    <svg
      aria-label={appearance().word}
      class={cn(
        'pointer-events-none inline-block size-1.5 shrink-0 rounded-full',
        appearance().dot,
        appearance().busy && 'animate-pulse-dot',
      )}
      data-status={dotStatus(props.look)}
    >
      <title>{appearance().word}</title>
    </svg>
  )
}

const kindIcons = { event: Zap, context: Zap, script: Radar, schedule: CalendarClock }

function KindIcon(props: { automation: Automation }) {
  const kind = createMemo(() => automationKind(props.automation))
  return (
    <Dynamic
      component={kindIcons[kind()]}
      aria-label={kind()}
      class="size-2.5 shrink-0 text-muted-foreground/50"
    />
  )
}
