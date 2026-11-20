import type { ReactNode } from 'react'
import { GitMergeIcon } from 'lucide-react'
import { cn, column, defineWebExtension, island, useConversation } from '@/sdk'
import { WorkspaceCall } from './call.solid.tsx'
import { useWorkspaceIndex } from './data.tsx'
import { LandingNote } from './landing-note.solid.tsx'
import { LanderLogEntry, LanderReport } from './log.solid.tsx'

function LanderComposer({ core, dock }: { core: ReactNode; dock?: boolean }) {
  const id = useConversation((conversation) => conversation.id)
  const landers = Object.values(useWorkspaceIndex().landerConversations)
  if (id === undefined || !landers.includes(id)) return core
  return (
    <div className={cn(column(dock), 'pb-3')}>
      <div
        className="flex items-center gap-2.5 rounded-lg border border-border/70 bg-muted/30 px-3.5 py-2.5 text-[12.5px] text-muted-foreground"
        data-lander-log={id}
      >
        <GitMergeIcon className="size-4 shrink-0 text-brand" />
        The landing log. The lander is code, not a model: each submission's outcome goes back to its
        branch.
      </div>
    </div>
  )
}

export default defineWebExtension({
  composer: LanderComposer,
  tools: { workspace: island(WorkspaceCall) },
  entries: {
    'lineage.note': island(LandingNote),
    'ultimate.lander': island(LanderLogEntry),
    'workspaces.lander-report': island(LanderReport),
  },
})
