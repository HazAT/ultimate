import { useState } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn, useExtensionUiState, useNow, useUltimate } from '@/sdk'
import {
  Dot,
  KindIcon,
  active,
  attention,
  lookOf,
  looks,
  openAutomationsPanel,
  since,
  stateLine,
  until,
  useAutomations,
  useOpenAutomation,
  worstFirst,
} from './parts.tsx'
import type { Automation } from './refs.ts'

const FIRST = 5

/** A few words for a row, fewer than the panel's line since the sidebar is narrow. */
function short(automation: Automation, now: number) {
  const look = lookOf(automation, now)
  const last = automation.runs.at(-1)
  if (look === 'working' && last) return `working ${since(last.firedAt, now)}`
  if (look === 'watching') return automation.fires > 0 ? `fired ${automation.fires}` : 'watching'
  if (look === 'scheduled' && automation.nextAt !== undefined) return until(automation.nextAt, now)
  return looks[look].word
}

/**
 * The Agent sidebar's Automations section: enabled or busy automations of both kinds, worst first; hidden while none is.
 * The heading folds it; its count opens the panel with every automation, paused ones included, and turns red while one
 * needs attention.
 */
export function AutomationsSection() {
  const { data } = useAutomations(5000)
  const now = useNow(10_000)
  const shell = useUltimate()
  const [expanded, setExpanded] = useExtensionUiState('sidebarOpen', true)
  const [all, setAll] = useState(false)
  const list = worstFirst(
    (data ?? []).filter((automation) => active(automation, now)),
    now,
  )
  if (list.length === 0) return null
  const failing = list.filter((automation) => attention(lookOf(automation, now))).length
  return (
    <Collapsible
      aria-label="Automations"
      className="mb-1 flex flex-col gap-px border-b border-border/60 pb-1"
      data-sidebar-section="automations"
      onOpenChange={setExpanded}
      open={expanded}
    >
      <div className="mx-2 flex h-6 items-center gap-1">
        <CollapsibleTrigger className="group/automations flex h-6 cursor-pointer items-center gap-1 rounded-md px-1 section-label outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">
          <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/automations:rotate-90" />
          Automations
        </CollapsibleTrigger>
        <button
          aria-label={`${list.length} active${failing ? `, ${failing} need attention` : ''}: show all automations`}
          className={cn(
            'cursor-pointer rounded-sm px-0.5 font-mono text-[11px] tabular-nums outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
            failing ? 'text-error' : 'text-muted-foreground',
          )}
          data-automations-open
          onClick={() => openAutomationsPanel(shell)}
          title={
            failing ? `${failing} need attention · show all automations` : 'Show all automations'
          }
          type="button"
        >
          {list.length}
        </button>
      </div>
      <CollapsibleContent className="flex flex-col gap-px">
        {(all ? list : list.slice(0, FIRST)).map((automation) => (
          <Row automation={automation} key={automation.id} now={now} />
        ))}
        {list.length > FIRST && (
          <button
            className="mx-2 h-5 cursor-pointer rounded-md pl-[26px] text-left font-mono text-[10px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => setAll(!all)}
            type="button"
          >
            {all ? 'fewer' : `+${list.length - FIRST} more`}
          </button>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

function Row({ automation, now }: { automation: Automation; now: number }) {
  const shell = useUltimate()
  const openAutomation = useOpenAutomation()
  const look = lookOf(automation, now)
  const last = automation.runs.at(-1)
  // A run that is going or just failed is what the user wants to see; a script opens beside its watcher.
  const run =
    last && (last.status === 'running' || look === 'failed') ? last.conversationId : undefined
  return (
    <button
      className="group/row mx-2 flex h-7 min-w-0 cursor-pointer items-center gap-2 rounded-md pr-2 pl-2.5 text-left outline-none hover:bg-sidebar-accent/50 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
      data-sidebar-automation={automation.id}
      onClick={() => {
        if (automation.script) return openAutomation(automation.id)
        if (run === undefined) return openAutomationsPanel(shell)
        shell.showSurface('agent')
        shell.switchConversation(run)
      }}
      title={`${automation.id} · ${automation.name}\n${looks[look].word} · ${stateLine(automation, now)}`}
      type="button"
    >
      <Dot look={look} />
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground/85">
        {automation.name}
      </span>
      <KindIcon automation={automation} className="size-2.5 text-muted-foreground" />
      <span
        className={cn(
          'shrink-0 font-mono text-[10px] tabular-nums',
          look === 'watching' || look === 'scheduled' ? 'text-muted-foreground' : looks[look].text,
        )}
      >
        {short(automation, now)}
      </span>
    </button>
  )
}
