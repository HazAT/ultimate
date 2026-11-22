import { Flag, LoaderCircle } from '@lucide/solid'
import { Show, createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog.solid.tsx'
import { Form } from '@/components/ui/form.solid.tsx'
import { Textarea } from '@/components/ui/input.solid.tsx'
import { api, errorMessage, useDialog, writingAs } from '@/sdk/solid'
import { openUltimate, useOpenGoal } from './chip.solid.tsx'
import { StartAction } from './refs.ts'

export const goalDialog = 'goal.start'

export function GoalDialog() {
  const [open, setOpen] = useDialog(goalDialog)
  return (
    <Dialog open={open()} onOpenChange={setOpen}>
      <DialogContent
        class="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] gap-0 overflow-y-auto p-0 sm:max-w-[30rem]"
        data-goal-dialog
        showCloseButton={false}
      >
        <GoalForm close={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}

function GoalForm(props: { close: () => void }) {
  const active = useOpenGoal()
  const [text, setText] = createSignal('')
  const [failure, setFailure] = createSignal<string>()
  const canStart = () => !active() && !!text().trim()

  async function start(source: string) {
    if (!canStart()) return
    const close = props.close
    setFailure(undefined)
    try {
      await api.action(StartAction, { text: text() })
    } catch (error) {
      setFailure(errorMessage(error))
      return
    }
    writingAs(source, close)
    await openUltimate(source)
  }

  return (
    <Form>
      <div class="space-y-4 px-6 pt-6 pb-5">
        <div class="space-y-2">
          <DialogTitle class="flex items-center gap-2 text-base">
            <Flag aria-hidden="true" class="size-4 text-brand" />
            Give @ultimate a goal
          </DialogTitle>
          <DialogDescription class="text-[13px] leading-relaxed text-muted-foreground">
            Give me a goal and go. I write down what done means, then work toward it without you:
            whatever I would ask you, I decide myself, including approving UI previews, and note
            each decision with its reason. When every criterion is met, or every one left is stuck
            after three tries, I stop and leave you a report.
          </DialogDescription>
        </div>
        <Textarea
          aria-label="The goal"
          class="min-h-24 bg-transparent"
          data-goal-text
          disabled={!!active()}
          onValueChange={setText}
          placeholder="Make the sidebar load instantly with 2,000 conversations. Stop by 8:00."
          rows={4}
          submitShortcut="mod+enter"
          value={text()}
        />
        <p class="text-[12px] leading-relaxed text-muted-foreground">
          Secrets, logins and force pushes stay yours. <span class="text-foreground">Pause</span> in
          the status line stops everything at once; End on the goal's card hands decisions back to
          you.
        </p>
      </div>
      <footer class="space-y-3 border-t border-border/60 bg-muted/30 px-6 py-4">
        <Show when={active()}>
          {(goal) => (
            <p class="text-[12px] leading-relaxed text-muted-foreground" data-goal-blocked>
              <span class="text-foreground">Goal {goal().id} is still open.</span> End it from its
              card in @ultimate's conversation first.
            </p>
          )}
        </Show>
        <Show when={failure()}>
          <p class="text-[12px] break-words text-error" role="alert">
            {failure()}
          </p>
        </Show>
        <div class="flex items-center justify-end gap-2">
          <Button onClick={() => props.close()} size="sm" variant="ghost">
            {active() ? 'Close' : 'Not now'}
          </Button>
          <Button
            class="group/goal-start"
            data-agent-confirm="Hands decisions to @ultimate until the goal ends."
            data-goal-start
            disabled={!canStart()}
            onClick={(_, details) => start(details.source)}
            pendingAnnouncement="Starting hands-off goal"
            size="sm"
            type="submit"
          >
            <LoaderCircle
              aria-hidden="true"
              class="hidden group-data-pending/goal-start:block motion-safe:animate-spin"
            />
            Go hands-off
          </Button>
        </div>
      </footer>
    </Form>
  )
}
