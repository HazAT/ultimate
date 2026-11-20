import { defineWebExtension, island } from '@/sdk'
import { GoalCall } from './call.solid.tsx'
import { ModelOnlyNote, ReportCard, StartedCard } from './cards.solid.tsx'
import { HandsOff } from './chip.solid.tsx'
import { GoalDialog, goalDialog } from './dialog.solid.tsx'

export default defineWebExtension({
  tools: { goal: island(GoalCall) },
  entries: {
    'goal.started': island(StartedCard),
    'goal.report': island(ReportCard),
    'goal.note': island(ModelOnlyNote),
  },
  slots: { 'statusline.right': [island(HandsOff)], overlay: [island(GoalDialog)] },
  commands: [
    { id: 'goal.start', title: 'Go hands-off…', run: (context) => context.open(goalDialog) },
  ],
})
