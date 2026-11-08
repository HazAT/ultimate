/**
 * The way from a finished dream into a fresh chapter, in the sidebar and the status line on every surface: once the
 * dream branch is concluded, Fall asleep asks @ultimate to prepare the chapter; once it is prepared, the Fall asleep
 * card opens. The user may stay in this chapter instead.
 */
import { LoaderCircleIcon, MoonIcon, MoonStarIcon } from 'lucide-react'
import { useState } from 'react'
import { api, errorMessage, useDocOf, useUltimate } from '@/sdk'
import { useConcludedSince } from '../conversations/ui.tsx'
import { talkToUltimate } from '../subagents/ui.tsx'
import { DismissAction, DreamDoc, ReadyAction } from './refs.ts'
import { dreamStage } from './stage.ts'

/** The dialog the pinned line opens: the Fall asleep card. */
export const nextDialog = 'dream.next'

/** The dream document and its stage (`dreamStage`); undefined until the document loads. */
export function useDreamStage() {
  const doc = useDocOf(1, DreamDoc)
  const concluded = useConcludedSince()
  return doc && { doc, stage: dreamStage(doc, concluded) }
}

/**
 * The sidebar cue's phase: `woke` and `preparing` as the stage says, `prepared` while a prepared chapter waits, falls
 * asleep or failed to; undefined when there is nothing to do.
 */
export function useAwake() {
  const { doc, stage } = useDreamStage() ?? {}
  if (stage === 'woke' || stage === 'preparing') return { phase: stage }
  if (stage === 'prepared' || stage === 'sleeping' || stage === 'failed')
    return { phase: 'prepared' as const, chapter: doc!.prepared!.chapter }
  return undefined
}

/** The sidebar's cue: what the dream left to do, and the button that does it; `onAct` after it did. */
export function AwakeSection({ onAct }: { onAct?: () => void }) {
  const awake = useAwake()
  const actions = useUltimate()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  if (!awake) return null
  const run = async (step: () => Promise<unknown>) => {
    setBusy(true)
    setFailure(undefined)
    try {
      await step()
      onAct?.()
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  const ready = () =>
    run(async () => {
      await api.action(ReadyAction, null)
      await talkToUltimate(actions)
    })
  return (
    <section
      aria-label="Fall asleep"
      className="mx-2 mb-1.5 rounded-md border border-l-2 border-border/70 border-l-brand/60 bg-muted/30 px-2.5 py-2"
      data-dream-awake={awake.phase}
    >
      <p className="flex items-start gap-1.5 text-[12px] leading-snug">
        <MoonStarIcon className="mt-px size-3.5 shrink-0 text-brand" />
        <span className="text-foreground">
          {awake.phase === 'prepared'
            ? `Chapter ${awake.chapter} is ready`
            : awake.phase === 'preparing'
              ? 'Preparing the next chapter'
              : 'The dream is done'}
        </span>
      </p>
      <p className="mt-1 ml-5 text-[11.5px] leading-snug text-muted-foreground">
        {awake.phase === 'prepared'
          ? 'Fall asleep when you are ready: my handover carries the open work.'
          : awake.phase === 'preparing'
            ? '@ultimate is writing its handover; Fall asleep follows.'
            : 'Time to fall asleep: @ultimate writes its handover, then you confirm.'}
      </p>
      {failure && (
        <p className="mt-1 ml-5 text-[11.5px] leading-snug text-error" role="alert">
          {failure}
        </p>
      )}
      <div className="mt-1.5 ml-5 flex flex-wrap items-center gap-x-3 gap-y-1">
        {awake.phase === 'preparing' ? (
          <button
            className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-foreground/85 hover:text-foreground"
            onClick={() => {
              onAct?.()
              // Opening a conversation fails only when @ultimate is unknown; the sidebar row stays as it is then.
              talkToUltimate(actions).catch(() => undefined)
            }}
            type="button"
          >
            <LoaderCircleIcon className="size-3 text-brand motion-safe:animate-spin" />
            Open @ultimate
          </button>
        ) : (
          <button
            className="flex cursor-pointer items-center gap-1.5 rounded-md border border-brand/50 px-2 py-0.5 text-[12px] text-foreground transition-colors outline-none hover:border-brand hover:bg-brand/10 focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
            data-dream-awake-asleep
            disabled={busy}
            onClick={() => {
              if (awake.phase !== 'prepared') return ready()
              else {
                onAct?.()
                actions.open(nextDialog)
                return undefined
              }
            }}
            type="button"
          >
            {busy ? (
              <LoaderCircleIcon className="size-3 text-brand motion-safe:animate-spin" />
            ) : (
              <MoonIcon className="size-3 text-brand" />
            )}
            Fall asleep…
          </button>
        )}
        {awake.phase !== 'prepared' && (
          <button
            className="cursor-pointer font-mono text-[11px] text-muted-foreground hover:text-foreground"
            data-dream-awake-dismiss
            disabled={busy}
            onClick={() => void run(() => api.action(DismissAction, null))}
            type="button"
          >
            Stay in this chapter
          </button>
        )}
      </div>
    </section>
  )
}
