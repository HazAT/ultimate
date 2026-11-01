/** The memory and notify tools as what they did: friendly rows with an icon, memory slugs as chips. */
import { BellIcon, BookOpenIcon, BrainIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolOutput,
  ToolSection,
  ToolStatusIcon,
} from '@/components/ai/tool'
import { cn, useToolDuration, useUltimate } from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { ConversationRef } from '../conversations/ui.tsx'
import { MemoryChip } from './ui.tsx'

const words = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const failed = (call: ToolCallView) => call.status === 'error' || call.status === 'interrupted'

/** One `remember` op as far as the model has written it; streaming args may be partial. */
export type RememberOp = {
  op: 'add' | 'update' | 'delete'
  slug: string
  kind?: string
  line?: string
  body?: string
  source?: string
}

/** The well-formed ops of a `remember` call's arguments, in order. */
export function rememberOps(ops: unknown): RememberOp[] {
  if (!Array.isArray(ops)) return []
  return ops.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const { op, slug, kind, line, body, source } = raw as Record<string, unknown>
    if ((op !== 'add' && op !== 'update' && op !== 'delete') || !words(slug)) return []
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)
    return [
      {
        op,
        slug: words(slug),
        kind: text(kind),
        line: text(line),
        body: text(body),
        source: text(source),
      },
    ]
  })
}

const verbs = { add: 'added', update: 'updated', delete: 'deleted' } as const

/** What a batch did: `updated fleet-failure-modes` for one op, `added 2 · updated 1 · deleted 1` for more. */
export function rememberSummary(ops: readonly RememberOp[]) {
  if (ops.length === 1) return `${verbs[ops[0].op]} ${ops[0].slug}`
  return (['add', 'update', 'delete'] as const)
    .map((op) => [op, ops.filter((item) => item.op === op).length] as const)
    .filter(([, count]) => count)
    .map(([op, count]) => `${verbs[op]} ${count}`)
    .join(' · ')
}

const prose = 'font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/90'

/** A `remember` batch: what changed in the header, each op as a readable block. */
export function RememberCall({ call, core }: { call: ToolCallView; core: ReactNode }) {
  const duration = useToolDuration(call)
  if (failed(call)) return core
  const ops = rememberOps(call.args.ops)
  // A deleted memory is gone: its slug opens nothing, so only the others show as chips.
  const kept = [...new Set(ops.filter((op) => op.op !== 'delete').map((op) => op.slug))]
  // One op whose memory is kept names it by its chip alone.
  const sole = ops.length === 1 && kept.length === 1
  return (
    <Tool>
      <ToolHeader
        action={
          kept.length > 0 && (
            // On a phone a batch's chips would crowd out the summary; its unfolded ops carry them.
            <span
              className={cn(
                'max-w-[45%] shrink-0 items-center gap-1 overflow-hidden',
                sole ? 'flex' : 'hidden sm:flex',
              )}
            >
              {kept.slice(0, 2).map((slug) => (
                <MemoryChip className="min-w-0" key={slug} slug={slug} />
              ))}
              {kept.length > 2 && (
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  +{kept.length - 2}
                </span>
              )}
            </span>
          )
        }
        icon={BrainIcon}
        meta={duration}
        name=""
        state={call.status}
        title={
          <>
            <span className="text-foreground">Memory</span>
            {ops.length > 0 && <span> · {sole ? verbs[ops[0].op] : rememberSummary(ops)}</span>}
          </>
        }
      />
      <ToolContent>
        {ops.map((op, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- Ordered batch operations can target the same slug.
          <ToolSection className="border-b border-border/50 last:border-b-0" key={index}>
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  'shrink-0 section-label',
                  op.op === 'delete' ? 'text-error/80' : 'text-muted-foreground',
                )}
              >
                {verbs[op.op]}
              </span>
              {op.op === 'delete' ? (
                <span className="truncate text-muted-foreground line-through">{op.slug}</span>
              ) : (
                <MemoryChip slug={op.slug} />
              )}
              {op.kind && <span className="shrink-0 text-muted-foreground">{op.kind}</span>}
              {op.source && (
                <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                  {op.source}
                </span>
              )}
            </div>
            {op.line && <p className={cn(prose, 'font-medium text-foreground')}>{op.line}</p>}
            {op.body && <p className={cn(prose, 'text-foreground/80')}>{op.body}</p>}
          </ToolSection>
        ))}
      </ToolContent>
    </Tool>
  )
}

/** A `memory` read: one memory with its chip, or the index. */
export function MemoryCall({ call, core }: { call: ToolCallView; core: ReactNode }) {
  const duration = useToolDuration(call)
  if (failed(call)) return core
  const slug = words(call.args.read)
  return (
    <Tool>
      <ToolHeader
        action={slug && <MemoryChip className="shrink-0" slug={slug} />}
        icon={BookOpenIcon}
        meta={duration}
        name=""
        state={call.status}
        title={slug ? 'Read memory' : 'Read the memory index'}
      />
      <ToolContent>
        <ToolOutput output={call.output} />
      </ToolContent>
    </Tool>
  )
}

/** A `notify` request: one flat row, with the conversation it waits on as a link. */
export function NotifyCall({ call, core }: { call: ToolCallView; core: ReactNode }) {
  const { switchConversation } = useUltimate()
  if (failed(call)) return core
  const id = typeof call.args.id === 'number' ? call.args.id : undefined
  return (
    <Tool>
      <div className="flex h-8 min-w-0 items-center gap-2 px-2.5 text-muted-foreground">
        <ToolStatusIcon icon={BellIcon} state={call.status} />
        <span className="shrink-0 text-foreground">Notify when</span>
        {id !== undefined && (
          <button
            className="min-w-0 cursor-pointer overflow-hidden text-foreground/85 hover:underline"
            onClick={() => switchConversation(id)}
            title={`Open #${id}`}
            type="button"
          >
            <ConversationRef id={id} />
          </button>
        )}
        <span className="shrink-0">finishes</span>
        {call.args.wake === false && (
          <span className="ml-auto shrink-0 text-[11px]" title="Leaves a note instead of waking">
            <span className="hidden sm:inline">as a note, </span>no wake-up
          </span>
        )}
      </div>
    </Tool>
  )
}
