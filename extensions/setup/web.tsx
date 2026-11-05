import { TriangleAlertIcon } from 'lucide-react'
import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  cn,
  defineWebExtension,
  events,
  useAction,
  useCommands,
  useEvent,
  useEvents,
  useSystem,
  useUltimate,
} from '@/sdk'
import { Changed as HealthChanged } from '../health/ui.tsx'
import { LoginChanged } from '../models/ui.tsx'
import { CheckAction } from './refs.ts'
import type { SetupIssue } from './refs.ts'

const mark = { warn: '⚠', info: '·', ok: '✓' } as const
const tone = { warn: 'text-warning', info: 'text-muted-foreground', ok: 'text-success' } as const

/** The fix button of a row: runs its command, or opens the Secrets panel at its secret. */
function Fix({ fix }: { fix: NonNullable<SetupIssue['fix']> }) {
  const ui = useUltimate()
  const commands = useCommands()
  if (fix.command && !commands.some((command) => command.id === fix.command)) return null
  return (
    <Button
      className="h-6 shrink-0 px-2 text-[0.6875rem]"
      onClick={() =>
        fix.secret ? events.emit('secrets:open', { name: fix.secret }) : ui.runCommand(fix.command!)
      }
      size="sm"
      variant="outline"
    >
      {fix.label}
    </Button>
  )
}

function Row({ issue }: { issue: SetupIssue }) {
  return (
    <li className="flex items-start gap-2 py-1">
      <span className={cn('w-3 shrink-0', tone[issue.status])}>{mark[issue.status]}</span>
      <div className="min-w-0 flex-1">
        <div className="flex gap-2">
          <span className="w-28 shrink-0 text-foreground/85 max-sm:w-24">{issue.area}</span>
          <span
            className={cn(
              'min-w-0 flex-1 break-words',
              issue.status === 'warn' ? 'text-foreground/85' : 'text-muted-foreground',
            )}
          >
            {issue.summary}
          </span>
        </div>
        {issue.impact && issue.status !== 'ok' && (
          <div className="mt-0.5 text-muted-foreground">{issue.impact}</div>
        )}
      </div>
      {issue.fix && issue.status !== 'ok' && <Fix fix={issue.fix} />}
    </li>
  )
}

/**
 * "⚠ N setup issues" while something on this machine isn't set up; nothing otherwise. Read on mount, every minute,
 * after a secret, login or provider health changes and when an extension is enabled, disabled or fails to load.
 */
function Setup() {
  const system = useSystem()
  const { data, refetch } = useAction(
    CheckAction,
    null,
    // A failed poll keeps the last state; the next one tries again.
    { onError: () => {} },
  )
  const signature = JSON.stringify(
    system?.extensions.map((extension) => [
      extension.name,
      extension.enabled,
      extension.server?.error,
    ]),
  )
  useEffect(() => void refetch(), [signature, refetch])
  useEffect(() => {
    const timer = setInterval(() => void refetch(), 60_000)
    return () => clearInterval(timer)
  }, [refetch])
  useEvent('secrets:changed', () => void refetch())
  // A login or provider health change re-checks at once; the minute poll covers the file-backed areas.
  const latest = useEvents({ events: [LoginChanged, HealthChanged], limit: 1 })?.[0]?.id
  useEffect(() => void refetch(), [latest, refetch])
  const warnings = data?.filter((issue) => issue.status === 'warn') ?? []
  if (!warnings.length) return null
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-warning transition-colors hover:bg-accent"
          data-setup-issues={warnings.length}
          type="button"
        >
          <TriangleAlertIcon className="size-3" />
          {warnings.length}
          <span className="max-md:hidden">setup issue{warnings.length === 1 ? '' : 's'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[34rem] max-w-[calc(100vw-1rem)] p-0 font-mono"
        side="top"
      >
        <div className="border-b border-border/70 px-3 py-2 text-[0.7188rem] text-muted-foreground">
          What isn't set up on this machine, and what it costs.
        </div>
        <ul className="max-h-[60vh] overflow-y-auto px-3 py-1.5 text-[0.7188rem] leading-[1.5]">
          {data!.map((issue, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- Check results have no id; areas and failures may repeat.
            <Row issue={issue} key={`${issue.area}-${index}`} />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

export default defineWebExtension({
  // Shown only while something needs setting up, so it stays on a phone's line too.
  slots: { 'statusline.right': [{ component: Setup, phone: true }] },
  // The agent's note about setup changes; the user sees setup in the status line.
  entries: { 'setup.note': () => null },
})
