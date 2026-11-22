import { defineWebExtension } from '@/sdk/solid'
import { WorkspaceCall } from './call.solid.tsx'
import { LanderComposer } from './lander-composer.solid.tsx'
import { LandingNote } from './landing-note.solid.tsx'
import { LanderLogEntry, LanderReport } from './log.solid.tsx'

export default defineWebExtension({
  composer: LanderComposer,
  tools: { workspace: WorkspaceCall },
  entries: {
    'lineage.note': LandingNote,
    'ultimate.lander': LanderLogEntry,
    'workspaces.lander-report': LanderReport,
  },
})
