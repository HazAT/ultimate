import { CompassIcon, LoaderCircleIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { api, errorMessage, useAction, useConversation, useDocOf, useSystem } from '@/sdk'
import { column, MemoryDoc, useRoots } from '../lineage/ui.tsx'
import { StandingDoc } from '../subagents/ui.tsx'
import { onboarded } from './onboarded.ts'
import { DismissAction, StartAction, StartsDoc, StatusAction } from './refs.ts'

/** Above @ultimate's composer until onboarding has run for the project: one click starts it. */
export function StartComposer({ core, dock }: { core: ReactNode; dock?: boolean }) {
  const id = useConversation((conversation) => conversation.id)
  const ultimate = useDocOf(1, StandingDoc)?.ultimate
  if (id === undefined || id !== ultimate) return core
  return (
    <>
      <StartHere dock={dock} />
      {core}
    </>
  )
}

function StartHere({ dock }: { dock?: boolean }) {
  const root = useRoots()?.[0]
  const starts = useDocOf(1, StartsDoc)
  const memories = useDocOf(root ?? 1, MemoryDoc)
  const project = useSystem()?.project.name
  const status = useAction(StatusAction).data
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  if (root === undefined || starts === undefined || memories === undefined || !status) return null
  if (status.off || starts?.dismissed || onboarded(starts?.roots[String(root)], memories))
    return null
  const run = async (action: () => Promise<unknown>) => {
    setSending(true)
    setError(undefined)
    try {
      await action()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setSending(false)
    }
  }
  return (
    <div className={`${column(dock)} pb-2`}>
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-2.5 rounded-lg border border-brand/30 bg-brand/5 px-3.5 py-3"
        data-onboarding-start={root}
      >
        <CompassIcon className="size-4 shrink-0 text-brand" />
        <div className="min-w-0 flex-1 basis-60">
          <p className="text-[0.8438rem] font-medium text-foreground">
            Let Ultimate get familiar with {project ?? 'the project'}
          </p>
          <p className="text-[0.7812rem] leading-snug text-muted-foreground">
            {error ??
              '@ultimate walks you through how it works, helps you choose your setup and reads the project.'}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button
            disabled={sending}
            onClick={() => void run(() => api.action(StartAction, { root }))}
          >
            {sending ? <LoaderCircleIcon className="motion-safe:animate-spin" /> : <CompassIcon />}
            Set up with @ultimate
          </Button>
          <Button
            aria-label="Dismiss"
            className="text-muted-foreground hover:text-foreground"
            disabled={sending}
            onClick={() => void run(() => api.action(DismissAction))}
            size="icon-sm"
            title="Not now. ⌘K Get ready… starts setup later."
            variant="ghost"
          >
            <XIcon />
          </Button>
        </div>
      </div>
    </div>
  )
}
