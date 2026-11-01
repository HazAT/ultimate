import { FlagIcon, LoaderCircleIcon } from 'lucide-react'
import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { api, errorMessage, useDialog, useDocOf, useUltimate } from '@/sdk'
import { talkToUltimate } from '../subagents/ui.tsx'
import { GoalDoc, StartAction } from './refs.ts'

/** The dialog ⌘K "Go hands-off…" opens. */
export const goalDialog = 'goal.start'

/** What going hands-off means, the goal in the user's words, and the button that grants it. */
export function GoalDialog() {
  const [open, setOpen] = useDialog(goalDialog)
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] gap-0 overflow-y-auto p-0 sm:max-w-[30rem]"
        data-goal-dialog
      >
        {open && <Body onClose={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function Body({ onClose }: { onClose: () => void }) {
  const active = useDocOf(1, GoalDoc)?.goals.find((goal) => !goal.ended)
  const actions = useUltimate()
  const [text, setText] = useState('')
  const [starting, setStarting] = useState(false)
  const [failure, setFailure] = useState<string>()
  const start = async () => {
    if (!text.trim() || active) return
    setStarting(true)
    setFailure(undefined)
    try {
      await api.action(StartAction, { text })
      onClose()
      await talkToUltimate(actions)
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setStarting(false)
    }
  }
  const submitOnModEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    // oxlint-disable-next-line typescript/no-floating-promises -- start catches failures and shows them with setFailure.
    void start()
  }
  return (
    <>
      <div className="space-y-4 px-6 pt-6 pb-5">
        <div className="space-y-2">
          <DialogTitle className="flex items-center gap-2 text-base">
            <FlagIcon className="size-4 text-brand" />
            Go hands-off
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed text-muted-foreground">
            Give me a goal and go. I write down what done means, then work toward it without you:
            whatever I would ask you, I decide myself, including approving UI previews, and note
            each decision with its reason. When every criterion is met, or every one left is stuck
            after three tries, I stop and leave you a report.
          </DialogDescription>
        </div>
        <textarea
          aria-label="The goal"
          autoFocus
          className="min-h-24 w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-2.5 py-2 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
          data-goal-text
          disabled={!!active || starting}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={submitOnModEnter}
          placeholder="Make the sidebar load instantly with 2,000 conversations. Stop by 8:00."
          rows={4}
          value={text}
        />
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Secrets, logins and force pushes stay yours.{' '}
          <span className="text-foreground">Pause</span> in the status line stops everything at
          once; End on the goal's card hands decisions back to you.
        </p>
      </div>
      <footer className="space-y-3 border-t border-border/60 bg-muted/30 px-6 py-4">
        {active && (
          <p className="text-[12px] leading-relaxed text-muted-foreground" data-goal-blocked>
            <span className="text-foreground">Goal {active.id} is still open.</span> End it from its
            card in @ultimate's conversation first.
          </p>
        )}
        {failure && <p className="text-[12px] text-error">{failure}</p>}
        <div className="flex items-center justify-end gap-2">
          <Button onClick={onClose} size="sm" variant="ghost">
            {active ? 'Close' : 'Not now'}
          </Button>
          <Button
            data-goal-start
            disabled={!!active || !text.trim() || starting}
            onClick={() => void start()}
            size="sm"
          >
            {starting && <LoaderCircleIcon className="motion-safe:animate-spin" />}
            Go hands-off
          </Button>
        </div>
      </footer>
    </>
  )
}
