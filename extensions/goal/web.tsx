import { defineWebExtension, island } from '@/sdk'
import { GoalCall } from './call.tsx'
import { ReportCard, StartedCard } from './cards.tsx'
import { HandsOff } from './chip.solid.tsx'
import { GoalDialog, goalDialog } from './dialog.solid.tsx'

function ModelOnlyNote() {
  return null
}

export default defineWebExtension({
  tools: { goal: GoalCall },
  entries: {
    'goal.started': StartedCard,
    'goal.report': ReportCard,
    'goal.note': ModelOnlyNote,
  },
  slots: { 'statusline.right': [island(HandsOff)], overlay: [island(GoalDialog)] },
  commands: [
    { id: 'goal.start', title: 'Go hands-off…', run: (context) => context.open(goalDialog) },
  ],
})
