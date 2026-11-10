import { CalendarClockIcon, RadarIcon, TimerIcon, ZapIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool'
import { Button } from '@/components/ui/button'
import { cn, defineWebExtension, Fold, useToolDuration, useUltimate } from '@/sdk'
import type { EntryRecord, ToolCallView } from '@/sdk'
import { Chip } from './chip.tsx'
import { AutomationsPanel } from './panel.tsx'
import { Dot, looks, openAutomationsPanel, useOpenAutomation } from './parts.tsx'
import type { Look } from './parts.tsx'
import { AutomationsSection } from './sidebar.tsx'

type Kind = 'fired' | 'failed' | 'escalated' | 'writing'
const kinds: Record<Kind, { look: Look; word: string; border: string }> = {
  fired: { look: 'watching', word: 'fired', border: 'border-l-success/70' },
  failed: { look: 'investigating', word: 'failed', border: 'border-l-warning/70' },
  escalated: { look: 'failed', word: 'escalated', border: 'border-l-error/70' },
  writing: { look: 'writing', word: 'assigned', border: 'border-l-brand/60' },
}

/** `text` of a FIRE line may be JSON: show it as a code block then. */
function body(text: string) {
  const trimmed = text.trim()
  if (/^[[{]/.test(trimmed))
    try {
      return `\`\`\`json\n${JSON.stringify(JSON.parse(trimmed), null, 2)}\n\`\`\``
    } catch {
      // Not JSON after all: it reads as Markdown like any other text.
    }
  return text
}

/** An automation's input to a conversation: it fired, its script failed or was escalated, or the watcher's first task. */
const card = (kind: Kind) =>
  function AutomationEntry({ entry }: { entry: EntryRecord }) {
    const { id, name, text } = entry.data as { id: string; name: string; text: string }
    const look = kinds[kind]
    const open = useOpenAutomation()
    const label: ReactNode = (
      <>
        <span className="shrink-0 text-muted-foreground">{id}</span>
        <span className="min-w-0 truncate text-foreground" title={name}>
          {name}
        </span>
        <span className={cn('shrink-0', looks[look.look].text)}>{look.word}</span>
      </>
    )
    return (
      <Fold
        card={entry.id}
        summary={
          <>
            <Dot look={look.look} />
            <span className="flex min-w-0 items-center gap-1.5 text-foreground/80">{label}</span>
          </>
        }
      >
        <section
          className={cn(
            'min-w-0 rounded-md border border-l-2 border-border bg-muted/20',
            look.border,
          )}
          data-automation-entry={kind}
        >
          <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px]">
            <TimerIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 items-center gap-1.5">{label}</span>
            <button
              className="ml-auto shrink-0 cursor-pointer text-muted-foreground hover:text-foreground hover:underline"
              onClick={() => open(id)}
              title={`Show ${id} in Automations`}
              type="button"
            >
              open {id}
            </button>
          </header>
          {text && (
            <div
              className={cn(
                'min-w-0 px-3 py-2.5 text-[13px] leading-relaxed',
                kind === 'writing' && 'text-foreground/85',
              )}
            >
              <MessageResponse>{kind === 'writing' ? text : body(text)}</MessageResponse>
            </div>
          )}
        </section>
      </Fold>
    )
  }

const words = (value: unknown) => (typeof value === 'string' ? value : '')

/** The automation id a call touched: its argument, or the id its result line starts with. */
const touched = (call: ToolCallView) =>
  words(call.args.id) || (/^(A\d+|[a-z][a-z0-9-]*) .+ — /.exec(call.output)?.[1] ?? '')

/** One `automation` call: the action and automation, its ask or prompt, and a way to it. */
export function AutomationCall({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const shell = useUltimate()
  const open = useOpenAutomation()
  const action = words(call.args.action) || '…'
  const id = touched(call)
  const name = words(call.args.name)
  const schedule = words(call.args.schedule)
  const ask = words(call.args.ask)
  const prompt = words(call.args.prompt)
  const reason = words(call.args.reason)
  const Kind =
    call.args.event || call.args.condition
      ? ZapIcon
      : ask
        ? RadarIcon
        : schedule
          ? CalendarClockIcon
          : TimerIcon
  const title: ReactNode = (
    <>
      {action === 'run' ? 'run now' : action}
      {id && <span className="text-foreground/85"> {id}</span>}
      {name && <span className="text-foreground/85"> {name}</span>}
      {action === 'abort' && words(call.args.runId) && ` run ${words(call.args.runId)}`}
      {words(call.args.to) && ` → ${words(call.args.to)}`}
    </>
  )
  return (
    <Tool defaultOpen={call.status === 'error'}>
      <div className="flex items-center">
        <ToolHeader
          className="min-w-0 flex-1"
          meta={
            <>
              {schedule && <span className="max-w-48 truncate">{schedule}</span>}
              {ask && <span>{call.args.once === false ? 'watch' : 'watch once'}</span>}
              {duration && <span>{duration}</span>}
            </>
          }
          name="automation"
          state={call.status}
          title={title}
        />
        <Button
          className="mr-1 h-6 shrink-0 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => (id ? open(id) : openAutomationsPanel(shell))}
          size="sm"
          title={id ? `Show ${id} in Automations` : 'Show Automations'}
          variant="ghost"
        >
          <Kind className="size-3" />
          {id || 'automations'}
        </Button>
      </div>
      <ToolContent>
        {ask && (
          <ToolSection label="Watch for">
            <p className="font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/90">
              {ask}
            </p>
          </ToolSection>
        )}
        {prompt && (
          <ToolSection label="Prompt">
            <p className="font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/90">
              {prompt}
            </p>
          </ToolSection>
        )}
        {reason && (
          <ToolSection label="Reason">
            <p className="font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/90">
              {reason}
            </p>
          </ToolSection>
        )}
        <ToolOutput isError={call.status === 'error'} output={call.output} />
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}

export default defineWebExtension({
  messages: { ja: { 'Automations…': 'オートメーション…' } },
  tools: { automation: AutomationCall },
  slots: {
    'statusline.right': [{ component: Chip, order: -2 }],
    'sidebar.top': [{ component: AutomationsSection, order: -20 }],
  },
  entries: {
    'automations.fired': card('fired'),
    'automations.failed': card('failed'),
    'automations.escalated': card('escalated'),
    'automations.writing': card('writing'),
  },
  panels: [
    {
      id: 'automations',
      title: 'Automations',
      icon: TimerIcon,
      component: AutomationsPanel,
      // A working tab after Activity; also opened from the sidebar section, the chip, cards and ⌘K.
      order: 2.5,
    },
  ],
  commands: [
    {
      id: 'automations.open',
      title: 'Automations…',
      run: openAutomationsPanel,
    },
  ],
})
