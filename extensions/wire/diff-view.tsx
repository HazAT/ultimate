/** How a call's request differs from the one before it, in cache order: where the cached prefix held, and where not. */
import { ChevronRightIcon } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn, formatBytes, useAction } from '@/sdk'
import { DiffAction } from './refs.ts'
import type { WireDiff, WireSummary } from './refs.ts'
import { Node, Part } from './tree.tsx'
import type { Json } from './tree.tsx'

const parse = (json: string): Json => {
  try {
    return JSON.parse(json) as Json
  } catch {
    // A segment is always JSON.stringify output; this only guards a hand-edited file.
    return json
  }
}

/** The prefix as one bar: unchanged segments, then what this call sent new. */
function PrefixBar({ diff }: { diff: WireDiff }) {
  const added = diff.added.reduce((sum, segment) => sum + segment.json.length, 0)
  const total = diff.prefixBytes + added
  if (total === 0) return null
  return (
    <span aria-hidden className="flex h-1.5 overflow-hidden rounded-full bg-muted">
      <span className="bg-brand/60" style={{ width: `${(diff.prefixBytes / total) * 100}%` }} />
      <span
        className={diff.firstChange ? 'bg-warning/70' : 'bg-muted-foreground/40'}
        style={{ width: `${(added / total) * 100}%` }}
      />
    </span>
  )
}

/** Where the prefix broke: the text before the first differing character, then both sides after it. */
function Break({ change }: { change: NonNullable<WireDiff['firstChange']> }) {
  const lead = change.lead.length >= 160 ? `…${change.lead}` : change.lead
  const side = (label: string, text: string, tone: string) => (
    <div className="flex gap-2">
      <span className="w-12 shrink-0 text-muted-foreground/70">{label}</span>
      <span className="min-w-0 break-all whitespace-pre-wrap">
        <span className="text-muted-foreground/60">{lead}</span>
        <span className={cn('rounded-[2px] px-px', tone)}>{text || '∅'}</span>
        {text.length >= 160 && <span className="text-muted-foreground/60">…</span>}
      </span>
    </div>
  )
  return (
    <section className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 text-warning">
        <span>prefix breaks at</span>
        <span className="text-foreground">{change.path}</span>
        <span className="text-muted-foreground">· character {change.offset.toLocaleString()}</span>
      </div>
      <p className="mt-1 font-sans text-[12.5px] text-muted-foreground">
        Everything from here on is written to the cache again, though most of it was sent before.
      </p>
      <div className="mt-2.5 flex flex-col gap-1.5 rounded-sm bg-terminal px-2.5 py-2 text-[11.5px] leading-[1.55]">
        {side('before', change.before, 'bg-diff-del/20 text-diff-del')}
        {side('after', change.after, 'bg-diff-add/20 text-diff-add')}
      </div>
    </section>
  )
}

/** A list of segment paths that folds once it is long. */
function Removed({ paths }: { paths: string[] }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="flex h-6 w-full cursor-pointer items-center gap-2 rounded-sm pr-2 pl-1 text-left hover:bg-accent/50">
        <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/60 transition-transform [[data-state=open]>&]:rotate-90" />
        <span className="min-w-0 truncate text-muted-foreground">
          {paths.slice(0, 6).join(', ')}
          {paths.length > 6 ? ` … ${paths.length - 6} more` : ''}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col pl-6">
        {paths.map((path) => (
          <span className="text-diff-del/90" key={path}>
            {path}
          </span>
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

function Body({ diff, previous }: { diff: WireDiff; previous?: WireSummary }) {
  const pure = !diff.firstChange
  const added = diff.added.reduce((sum, segment) => sum + segment.json.length, 0)
  return (
    <>
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className={pure ? 'text-foreground/90' : 'text-warning'}>
            {pure ? 'pure append: the cached prefix held' : 'prefix changed'}
          </span>
          <span className="text-muted-foreground/70">
            vs #{diff.previous}
            {previous ? ` · ${previous.model}` : ''}
          </span>
        </div>
        <PrefixBar diff={diff} />
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-[2px] bg-brand/60" />
            unchanged{' '}
            <span className="text-foreground/90 tabular-nums">
              {diff.same} of {diff.segments}
            </span>{' '}
            segments · {formatBytes(diff.prefixBytes)}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                'size-2 rounded-[2px]',
                pure ? 'bg-muted-foreground/40' : 'bg-warning/70',
              )}
            />
            {pure ? 'appended' : 'from the break on'}{' '}
            <span className="text-foreground/90 tabular-nums">{diff.added.length}</span> ·{' '}
            {formatBytes(added)}
          </span>
        </div>
      </section>
      {diff.firstChange && (
        <div className="mt-5">
          <Break change={diff.firstChange} />
        </div>
      )}
      {diff.settings.length > 0 && (
        <Part note="outside the prefix" title="settings changed">
          <div className="flex flex-col gap-0.5 px-1 py-1">
            {diff.settings.map((setting) => (
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2" key={setting.key}>
                <span className="w-40 shrink-0 truncate text-muted-foreground">{setting.key}</span>
                <span className="text-diff-del">{setting.before ?? '∅'}</span>
                <span className="text-muted-foreground/60">→</span>
                <span className="text-diff-add">{setting.after ?? '∅'}</span>
              </div>
            ))}
          </div>
        </Part>
      )}
      {diff.added.length > 0 && (
        <Part
          note={pure ? 'new at the end' : 'sent again from the break on'}
          size={added}
          title={pure ? 'appended' : 'from the break'}
        >
          {diff.added.map((segment) => (
            <Node key={segment.path} label={segment.path} value={parse(segment.json)} />
          ))}
        </Part>
      )}
      {diff.removed.length > 0 && (
        <Part note={`in #${diff.previous} from the break on`} title="replaced">
          <Removed paths={diff.removed} />
        </Part>
      )}
    </>
  )
}

/** The diff of call `n` against the call kept before it. */
export function DiffView({ call, calls }: { call: WireSummary; calls: WireSummary[] }) {
  const diff = useAction(DiffAction, { n: call.n })
  const previous = calls.filter((other) => other.n < call.n).at(-1)
  if (diff.data) return <Body diff={diff.data} previous={previous} />
  if (diff.loading || diff.data === undefined)
    return <p className="text-muted-foreground/70">comparing…</p>
  return (
    <p className="text-muted-foreground/70">
      {!previous
        ? 'The first call kept for this conversation: nothing earlier to compare with.'
        : previous.api !== call.api
          ? `#${previous.n} went to ${previous.api ?? previous.provider}, this one to ${call.api ?? call.provider}: a different body, so a different cache. Nothing to compare.`
          : `#${previous.n}'s body could not be compared.`}
    </p>
  )
}
