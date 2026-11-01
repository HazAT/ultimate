import { RotateCwIcon } from 'lucide-react'
import { defineWebExtension, useUltimate } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { ConversationRef } from '../conversations/ui.tsx'
import type { BuildNote, Landing } from './refs.ts'

const short = (id: string) => id.slice(0, 7)

/** How many landings the divider names before "+N more". */
const named = 2

/** A landing in the divider: its branch, a link to it; a commit made outside Ultimate by its subject. */
function Landed({ row }: { row: Landing }) {
  const { switchConversation } = useUltimate()
  if (!row.conversation)
    return (
      <span className="min-w-0 truncate text-foreground/85" title={row.title}>
        {row.title}
      </span>
    )
  const id = row.conversation
  return (
    <button
      className="flex min-w-0 cursor-pointer overflow-hidden text-foreground/85 hover:underline"
      onClick={() => switchConversation(id)}
      title={`Open #${id}`}
      type="button"
    >
      <ConversationRef id={id} title={row.title} />
    </button>
  )
}

/**
 * The note on an input saying the build or the agent's instructions changed: one quiet divider naming what landed,
 * else what changed, its full text on hover.
 */
export function Note({ entry }: { entry: EntryRecord }) {
  const note = (entry.data ?? {}) as BuildNote
  const content = entry.model?.[0]?.content
  const landed = note.landed ?? []
  const parts = [
    note.from && note.to && !landed.length && `build ${short(note.from)} → ${short(note.to)}`,
    note.instructions?.length && `instructions: ${note.instructions.join(', ')}`,
    note.docs?.length && `docs: ${note.docs.join(', ')}`,
  ].filter(Boolean)
  if (parts.length === 0 && landed.length === 0) return null
  const label = note.from ? 'Reloaded' : 'Instructions changed'
  return (
    <div
      className="flex items-center gap-3 font-mono text-[0.6875rem] text-muted-foreground before:h-px before:flex-1 before:bg-brand/25 after:h-px after:flex-1 after:bg-brand/25"
      title={typeof content === 'string' ? content : undefined}
    >
      <span className="flex max-w-[85%] min-w-0 items-center gap-1.5">
        <RotateCwIcon className="size-3 shrink-0 text-brand" />
        <span className="shrink-0 text-brand">{label}</span>
        {landed.slice(0, named).map((row) => (
          <span className="flex min-w-0 items-center gap-1.5" key={row.conversation ?? row.sha}>
            <span className="shrink-0">·</span>
            <Landed row={row} />
          </span>
        ))}
        {landed.length > named && <span className="shrink-0">· +{landed.length - named} more</span>}
        {parts.length > 0 && <span className="truncate">· {parts.join(' · ')}</span>}
      </span>
    </div>
  )
}

export default defineWebExtension({
  entries: { 'prompt.build': Note },
})
