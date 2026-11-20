import { defineWebExtension, island } from '@/sdk'
import { WorkspaceCall } from './call.solid.tsx'
import { LanderComposer } from './lander-composer.solid.tsx'
import { LandingNote } from './landing-note.solid.tsx'
import { LanderLogEntry, LanderReport } from './log.solid.tsx'

export default defineWebExtension({
  composer: island(LanderComposer),
  tools: { workspace: island(WorkspaceCall) },
  entries: {
    'lineage.note': island(LandingNote),
    'ultimate.lander': island(LanderLogEntry),
    'workspaces.lander-report': island(LanderReport),
  },
})
