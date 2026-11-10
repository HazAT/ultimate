import { FlagIcon } from 'lucide-react'
import { defineWebExtension, useDocOf, useUltimate } from '@/sdk'
import { talkToUltimate } from '../subagents/ui.tsx'
import { GoalCall } from './call.tsx'
import { ReportCard, StartedCard } from './cards.tsx'
import { GoalDialog, goalDialog } from './dialog.tsx'
import { GoalDoc } from './refs.ts'

/** A quiet status-line mark while @ultimate works hands-off; it opens @ultimate, where the goal's card is. */
function HandsOff() {
  const goal = useDocOf(1, GoalDoc)?.goals.find((item) => !item.ended)
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

export default defineWebExtension({
  messages: { ja: { 'Go hands-off…': 'ハンズオフで任せる…' } },
  tools: { goal: GoalCall },
  entries: {
    'goal.started': StartedCard,
    'goal.report': ReportCard,
    // @ultimate's per-run reminder of the goal is model context, not something to read in the transcript.
    'goal.note': () => null,
  },
  slots: { 'statusline.right': [HandsOff], overlay: [GoalDialog] },
  commands: [
    { id: 'goal.start', title: 'Go hands-off…', run: (context) => context.open(goalDialog) },
  ],
})
