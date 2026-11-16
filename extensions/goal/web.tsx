import { ROOT } from '@/sdk'
import { FlagIcon } from 'lucide-react'
import { defineWebExtension, useDocOf, useUltimate } from '@/sdk'
import { talkToUltimate } from '../subagents/ui.tsx'
import { GoalCall } from './call.tsx'
import { ReportCard, StartedCard } from './cards.tsx'
import { GoalDialog, goalDialog } from './dialog.tsx'
import { GoalDoc } from './refs.ts'

function HandsOff() {
  const goal = useDocOf(ROOT, GoalDoc)?.goals.find((item) => !item.ended)
  const actions = useUltimate()
  if (!goal) return null
  return (
    <button
      className="-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      data-goal-status
      onClick={() => void talkToUltimate(actions)}
      title={`Hands-off: ${goal.text}`}
      type="button"
    >
      <FlagIcon className="size-3 text-brand" />
      Hands-off
    </button>
  )
}

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
  slots: { 'statusline.right': [HandsOff], overlay: [GoalDialog] },
  commands: [
    { id: 'goal.start', title: 'Go hands-off…', run: (context) => context.open(goalDialog) },
  ],
})
