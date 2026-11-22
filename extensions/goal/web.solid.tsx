import { defineWebExtension } from '@/sdk/solid'
import type { CompactRow } from '@/sdk/solid'
import { StandingDoc } from '../subagents/refs.ts'
import { GoalCall } from './call.solid.tsx'
import { ModelOnlyNote, ReportCard, StartedCard } from './cards.solid.tsx'
import { HandsOff } from './chip.solid.tsx'
import { GoalDialog, goalDialog } from './dialog.solid.tsx'

const proposes = (call: CompactRow['calls'][number]) =>
  call.name === 'goal' && (call.arguments as { action?: unknown }).action === 'propose'

export default defineWebExtension({
  tools: { goal: GoalCall },
  entries: {
    'goal.started': StartedCard,
    'goal.report': ReportCard,
    'goal.note': ModelOnlyNote,
  },
  slots: { 'statusline.right': [HandsOff], overlay: [GoalDialog] },
  commands: [
    { id: 'goal.start', title: 'Go hands-off…', run: (context) => context.open(goalDialog) },
  ],
  compact: {
    when: (conversation, docs) =>
      (docs[StandingDoc.kind] as Record<string, number> | null | undefined)?.ultimate ===
      conversation.id,
    tools: [proposes],
    docs: [StandingDoc.kind],
    thread: (row) => row.calls.some(proposes) || 'hidden',
  },
})
