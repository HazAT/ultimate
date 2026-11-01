import {
  CircleXIcon,
  MousePointerClickIcon,
  PlugIcon,
  SparklesIcon,
  WorkflowIcon,
  WrenchIcon,
  ZapIcon,
} from 'lucide-react'
import { cn, formatDuration, useAction } from '@/sdk'
import { TreeAction } from './refs.ts'
import type { SystemCall, SystemRow } from './refs.ts'

const icons: Record<string, typeof WrenchIcon> = {
  event: ZapIcon,
  tool: WrenchIcon,
  model: SparklesIcon,
  action: MousePointerClickIcon,
  service: PlugIcon,
  reactor: WorkflowIcon,
}

/** The icon of a row's kind: events, tools, model calls, actions, services and reactors each their own. */
export function KindIcon({ kind, ok = true }: { kind: string; ok?: boolean }) {
  const Icon = ok ? (icons[kind] ?? PlugIcon) : CircleXIcon
  return (
    <Icon
      aria-label={kind}
      className={cn(
        'mt-[3px] size-3 shrink-0',
        !ok
          ? 'text-error'
          : kind === 'event'
            ? 'text-brand'
            : kind === 'model'
              ? 'text-violet-500 dark:text-violet-300'
              : 'text-muted-foreground',
      )}
    />
  )
}

/** `14:02:31`: a row's time of day. */
export const clock = (at: string) => new Date(at).toLocaleTimeString(undefined, { hour12: false })

function Node({ call, depth }: { call: SystemCall; depth: number }) {
  return (
    <>
      <li
        className="flex min-w-0 items-start gap-1.5 py-px"
        style={{ paddingLeft: depth * 14 }}
        title={call.summary}
      >
        <KindIcon kind={call.kind} ok={call.ok} />
        <span className="shrink-0 text-foreground/85">{call.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {call.error ?? call.summary}
        </span>
        {call.ms !== undefined && (
          <span className="shrink-0 tabular-nums">{formatDuration(call.ms)}</span>
        )}
      </li>
      {call.children.map((child) => (
        <Node call={child} depth={depth + 1} key={child.id} />
      ))}
    </>
  )
}

/** The call tree of trace `trace`, with the events emitted in it, as quiet indented lines. */
export function TraceTree({ trace }: { trace: string }) {
  const tree = useAction(TreeAction, { trace })
  const events: SystemRow[] = tree.data?.events ?? []
  return (
    <div
      className="ml-4 border-l border-border/70 py-1 pr-1 pl-2 font-mono text-[10.5px] leading-[18px] text-muted-foreground"
      data-trace={trace}
    >
      {tree.loading && !tree.data && <p>loading…</p>}
      {tree.data && tree.data.calls.length === 0 && events.length === 0 && (
        <p>nothing recorded in this trace</p>
      )}
      <ul>
        {tree.data?.calls.map((call) => (
          <Node call={call} depth={0} key={call.id} />
        ))}
        {events.map((event) => (
          <li className="flex min-w-0 items-start gap-1.5 py-px" key={event.id}>
            <KindIcon kind="event" />
            <span className="shrink-0 text-foreground/85">{event.name}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{event.summary}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
