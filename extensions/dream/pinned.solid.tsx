import { MoonIcon } from '@lucide/solid'
import { Show, createMemo } from 'solid-js'
import { StatusButton } from '@/components/ui/status-trigger.solid.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog.solid.tsx'
import { useDialog } from '@/sdk/solid'
import { AwakeSection, nextDialog, useAwake, useDreamStage } from './awake.solid.tsx'
import { NextChapter } from './sleep.solid.tsx'

const awakeDialog = 'dream.awake'

export function DreamStatus() {
  const dream = useDreamStage()
  const [, setAwake] = useDialog(awakeDialog)
  const [, setNext] = useDialog(nextDialog)
  const stage = () => dream()?.stage
  const prepared = () =>
    stage() === 'none' || stage() === 'asleep' ? undefined : dream()?.doc.prepared
  const waking = createMemo(() => stage() === 'woke' || stage() === 'preparing')
  return (
    <Show
      when={waking()}
      fallback={
        <Show when={prepared()}>
          {(chapter) => (
            <StatusButton
              class="min-w-0"
              data-dream-status={chapter().chapter}
              onClick={() => setNext(true)}
              title={`Chapter ${chapter().chapter} is prepared: show the Fall asleep card`}
            >
              <MoonIcon class="size-3 shrink-0 text-brand" />
              <span class="truncate">
                {stage() === 'failed'
                  ? 'falling asleep failed'
                  : stage() === 'sleeping'
                    ? 'falling asleep'
                    : 'ready to fall asleep'}
              </span>
            </StatusButton>
          )}
        </Show>
      }
    >
      <StatusButton
        class="min-w-0"
        data-dream-status={stage()}
        onClick={() => setAwake(true)}
        title={
          stage() === 'woke'
            ? 'The dream is done: fall asleep into a fresh chapter'
            : '@ultimate is preparing the next chapter'
        }
      >
        <MoonIcon class="size-3 shrink-0 text-brand" />
        <span class="truncate">
          {stage() === 'woke' ? 'dream done · fall asleep' : 'preparing the next chapter'}
        </span>
      </StatusButton>
    </Show>
  )
}

export function AwakeDialog() {
  const [open, setOpen] = useDialog(awakeDialog)
  const awake = useAwake()
  return (
    <Dialog onOpenChange={setOpen} open={open() && !!awake() && awake()?.phase !== 'prepared'}>
      <DialogContent class="gap-0 p-2 pt-3 sm:max-w-[22rem]" data-dream-awake-dialog>
        <DialogTitle class="sr-only">Fall asleep</DialogTitle>
        <DialogDescription class="sr-only">The dream is done</DialogDescription>
        <AwakeSection onAct={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}

export function NextDialog() {
  const [open, setOpen] = useDialog(nextDialog)
  const dream = useDreamStage()
  const doc = createMemo(() => {
    const current = dream()
    const stage = current?.stage
    return stage === 'prepared' || stage === 'sleeping' || stage === 'failed'
      ? current?.doc
      : undefined
  })
  return (
    <Dialog onOpenChange={setOpen} open={open() && !!doc()}>
      <DialogContent
        class="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] gap-0 overflow-y-auto p-0 sm:max-w-[40rem]"
        data-dream-next-dialog
      >
        <DialogTitle class="sr-only">Fall asleep</DialogTitle>
        <DialogDescription class="sr-only">The next chapter I prepared</DialogDescription>
        <Show when={doc()?.prepared}>
          {(prepared) => (
            <NextChapter
              class="rounded-none border-0"
              name="chapter switch dialog"
              prepared={prepared()}
              sleep={doc()?.sleep}
            />
          )}
        </Show>
      </DialogContent>
    </Dialog>
  )
}
