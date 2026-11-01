import { LoaderCircleIcon, MoonIcon } from 'lucide-react'
import { Fragment, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { api, errorMessage, useDialog, useUltimate } from '@/sdk'
import { talkToUltimate } from '../subagents/ui.tsx'
import { StartAction } from './refs.ts'
import { passLabels } from './moon.tsx'
import { PASSES } from './types.ts'
import type { PassName } from './types.ts'

/** The dialog id the "Dream…" command, the Memory surface's button and the status-line hint open. */
export const dreamDialog = 'dream.start'

const passWhat: Record<PassName, string> = {
  memory: 'what is outdated, duplicated or never written down',
  failures: 'what broke often, and why',
  tools: 'which tools fail, crawl or go unused',
  corrections: 'what you told me twice, and what I wish I could do',
  codify: 'memories that should become how I work',
  project: 'what I keep doing by hand here, and what to build for it',
}

/** What pressing Dream does, and the button that starts it. */
export function DreamDialog() {
  const [open, setOpen] = useDialog(dreamDialog)
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      {/* One column that may shrink: an implicit `auto` grid column would grow to a long blocker title's width. */}
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] gap-0 overflow-y-auto p-0 sm:max-w-[30rem]"
        data-dream-dialog
      >
        {open && <Body onClose={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function Body({ onClose }: { onClose: () => void }) {
  const actions = useUltimate()
  const [starting, setStarting] = useState(false)
  const [failure, setFailure] = useState<string>()
  const start = async () => {
    setStarting(true)
    setFailure(undefined)
    try {
      await api.action(StartAction, null)
      onClose()
      await talkToUltimate(actions)
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setStarting(false)
    }
  }
  return (
    <>
      <div className="space-y-4 px-6 pt-6 pb-5">
        <div className="space-y-2">
          <DialogTitle className="flex items-center gap-2 text-base">
            <MoonIcon className="size-4 text-brand" />
            Dream
          </DialogTitle>
          <DialogDescription className="text-[0.8125rem] leading-relaxed text-muted-foreground">
            People make sense of the day while they sleep: what mattered settles, what didn't fades.
            A dream is that for me. I read back over our conversations, memory, failures and tools,
            and wake up with a journal of what I learned and a few changes I'd like to make.
          </DialogDescription>
        </div>
        <section className="space-y-1.5">
          <h3 className="section-label">Six passes</h3>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[0.8125rem] leading-5">
            {PASSES.map((pass) => (
              <Fragment key={pass}>
                <dt className="text-foreground">{passLabels[pass]}</dt>
                <dd className="text-muted-foreground">{passWhat[pass]}</dd>
              </Fragment>
            ))}
          </dl>
        </section>
        <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
          I start a dream branch with a handoff of everything I still remember. Its journal comes
          back to @ultimate's conversation, and we go through its proposals together. Each one you
          approve becomes an ordinary branch that is reviewed and lands as usual.{' '}
          <span className="text-foreground">Nothing changes code or memory by itself.</span> You can
          also just tell me to start dreaming.
        </p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 border-t border-border/60 pt-3 text-[0.75rem]">
          <dt className="text-muted-foreground">Takes</dt>
          <dd>about 30–60 minutes</dd>
          <dt className="text-muted-foreground">Costs</dt>
          <dd>real model tokens, roughly 1–3M</dd>
          <dt className="text-muted-foreground">Runs in</dt>
          <dd>
            this database{' '}
            <span className="text-muted-foreground">
              — starting a fresh chapter comes later, by your hand
            </span>
          </dd>
        </dl>
      </div>
      <footer className="space-y-3 border-t border-border/60 bg-muted/30 px-6 py-4">
        {failure && <p className="text-[0.75rem] text-error">{failure}</p>}
        <div className="flex items-center justify-end gap-2">
          <Button onClick={onClose} size="sm" variant="ghost">
            Not now
          </Button>
          <Button data-dream-start disabled={starting} onClick={() => void start()} size="sm">
            {starting && <LoaderCircleIcon className="motion-safe:animate-spin" />}
            Start dreaming
          </Button>
        </div>
      </footer>
    </>
  )
}
