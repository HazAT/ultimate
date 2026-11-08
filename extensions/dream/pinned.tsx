import { MoonIcon } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useDialog, useUltimate } from '@/sdk'
import { AwakeSection, nextDialog, useAwake, useDreamStage } from './awake.tsx'
import { NextChapter } from './sleep.tsx'

/** The dialog the pinned line opens after a dream, before a chapter is prepared: the sidebar's cue. */
const awakeDialog = 'dream.awake'

/** The prepared next chapter while it waits for Fall asleep, or a sleep that failed or runs. */
function usePinned() {
  const { doc, stage } = useDreamStage() ?? {}
  return stage === 'prepared' || stage === 'sleeping' || stage === 'failed' ? doc : undefined
}

/**
 * In the status line, on every surface and on phones: a finished dream waiting for Fall asleep, then the fresh chapter
 * prepared and not yet slept into.
 */
export function DreamStatus() {
  const { doc, stage } = useDreamStage() ?? {}
  const actions = useUltimate()
  if (stage === 'woke' || stage === 'preparing')
    return (
      <button
        className="-mx-1 flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground"
        data-dream-status={stage}
        onClick={() => actions.open(awakeDialog)}
        title={
          stage === 'woke'
            ? 'The dream is done: fall asleep into a fresh chapter'
            : '@ultimate is preparing the next chapter'
        }
        type="button"
      >
        <MoonIcon className="size-3 shrink-0 text-brand" />
        <span className="truncate">
          {stage === 'woke' ? 'dream done · fall asleep' : 'preparing the next chapter'}
        </span>
      </button>
    )
  if (!doc?.prepared || stage === 'none' || stage === 'asleep') return null
  return (
    <button
      className="-mx-1 flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground"
      data-dream-status={doc.prepared.chapter}
      onClick={() => actions.open(nextDialog)}
      title={`Chapter ${doc.prepared.chapter} is prepared: show the Fall asleep card`}
      type="button"
    >
      <MoonIcon className="size-3 shrink-0 text-brand" />
      <span className="truncate">
        {stage === 'failed'
          ? 'falling asleep failed'
          : stage === 'sleeping'
            ? 'falling asleep'
            : 'ready to fall asleep'}
      </span>
    </button>
  )
}

export function AwakeDialog() {
  const [open, setOpen] = useDialog(awakeDialog)
  const awake = useAwake()
  return (
    <Dialog onOpenChange={setOpen} open={open && !!awake && awake.phase !== 'prepared'}>
      <DialogContent className="gap-0 p-2 pt-3 sm:max-w-[22rem]" data-dream-awake-dialog>
        <DialogTitle className="sr-only">Fall asleep</DialogTitle>
        <DialogDescription className="sr-only">The dream is done</DialogDescription>
        <AwakeSection onAct={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}

export function NextDialog() {
  const [open, setOpen] = useDialog(nextDialog)
  const doc = usePinned()
  return (
    <Dialog onOpenChange={setOpen} open={open && !!doc}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] gap-0 overflow-y-auto p-0 sm:max-w-[40rem]"
        data-dream-next-dialog
      >
        <DialogTitle className="sr-only">Fall asleep</DialogTitle>
        <DialogDescription className="sr-only">The next chapter I prepared</DialogDescription>
        {doc?.prepared && (
          <NextChapter
            className="rounded-none border-0"
            prepared={doc.prepared}
            sleep={doc.sleep}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
