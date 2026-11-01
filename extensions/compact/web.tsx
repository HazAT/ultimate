import { FoldVerticalIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Tool, ToolContent, ToolHeader, ToolOutput, ToolSection } from '@/components/ai/tool'
import { defineWebExtension, useToolDuration } from '@/sdk'
import type { EntryRecord, ToolCallView } from '@/sdk'

type Compacted = {
  action: 'compact' | 'skip'
  before: number
  after: number
  collapsed: { from: number; to: number; tokens: number; note: string }[]
  trimmed: number[]
}

const k = (tokens: number) => `${Math.round(tokens / 1000)}k`

const prose = 'font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/85'

/** A `compact_in_place` call: what it did to the context in the header, each note with its range when open. */
function CompactCall({ call, core }: { call: ToolCallView; core: ReactNode }) {
  const duration = useToolDuration(call)
  if (call.status === 'error' || call.status === 'interrupted') return core
  const done = call.details as Compacted | undefined
  const action = String(call.args.action ?? '')
  const title =
    action === 'index' ? (
      'Read the context index'
    ) : !done ? (
      'Compacting in place'
    ) : (
      <>
        <span className="text-foreground">
          {done.action === 'skip' ? 'Compaction skipped' : 'Compacted in place'}
        </span>
        <span>
          {' '}
          · {k(done.before)} → {k(done.after)}
          {done.action === 'compact' &&
            ` · ${done.collapsed.length} collapsed · ${done.trimmed.length} trimmed`}
        </span>
      </>
    )
  return (
    <Tool>
      <ToolHeader
        icon={FoldVerticalIcon}
        meta={duration}
        name=""
        state={call.status}
        title={title}
      />
      <ToolContent>
        {action === 'index' || !done ? (
          <ToolOutput output={call.output} />
        ) : (
          <>
            {done.collapsed.map((item) => (
              <ToolSection className="border-b border-border/50 last:border-b-0" key={item.from}>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="section-label">collapsed</span>
                  <span className="font-mono">
                    {item.from === item.to ? item.from : `${item.from}–${item.to}`}
                  </span>
                  <span className="ml-auto">{k(item.tokens)} → note</span>
                </div>
                <p className={prose}>{item.note}</p>
              </ToolSection>
            ))}
            {done.trimmed.length > 0 && (
              <ToolSection>
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="section-label">trimmed outputs</span>
                  <span className="font-mono">{done.trimmed.join(' · ')}</span>
                </div>
              </ToolSection>
            )}
          </>
        )}
      </ToolContent>
    </Tool>
  )
}

/** The call in a folded "worked" row: what it did to the context, in one line. */
function CompactLine({ call }: { call: ToolCallView }) {
  const done = call.details as Compacted | undefined
  if (call.args.action === 'index') return <>Read the context index</>
  if (!done) return <>Compacting in place</>
  return (
    <>
      <span className="text-foreground/80">
        {done.action === 'skip' ? 'Compaction skipped' : 'Compacted in place'}
      </span>{' '}
      {k(done.before)} → {k(done.after)}
    </>
  )
}

/** A nudge: one quiet line with the context size it fired at. */
function Nudge({ entry }: { entry: EntryRecord }) {
  const tokens = (entry.data as { tokens?: number } | undefined)?.tokens
  return (
    <div className="flex items-center gap-2 px-1 font-mono text-[11px] text-muted-foreground">
      <FoldVerticalIcon className="size-3 shrink-0" />
      <span>context {tokens ? k(tokens) : ''} · asked to compact in place</span>
    </div>
  )
}

export default defineWebExtension({
  tools: { compact_in_place: CompactCall },
  toolLines: { compact_in_place: CompactLine },
  entries: { 'compact.nudge': Nudge, 'compact.edits': () => null },
})
