/** @jsxImportSource @solidjs/web */
import { ROOT } from '@/sdk/solid'
import { LoaderCircleIcon, MoonIcon, MoonStarIcon } from '@lucide/solid'
import { Show, createMemo, createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  api,
  errorMessage,
  showSurface,
  switchConversation,
  useDialog,
  useDocOf,
  writerNow,
  writingAs,
} from '@/sdk/solid'
import { meansNone } from '../../lib/errors.ts'
import { useConcludedSince } from '../conversations/ui.solid.tsx'
import { talkToUltimate } from '../subagents/ui.solid.tsx'
import { DismissAction, DreamDoc, ReadyAction } from './refs.ts'
import { dreamStage } from './stage.ts'

export const nextDialog = 'dream.next'

export function useDreamStage() {
  const doc = useDocOf(() => ROOT, DreamDoc)
  const concluded = useConcludedSince()
  return createMemo(() => {
    const current = doc()
    return current ? { doc: current, stage: dreamStage(current, concluded) } : undefined
  })
}

export function useAwake() {
  const dream = useDreamStage()
  return createMemo(() => {
    const { doc, stage } = dream() ?? {}
    if (stage === 'woke' || stage === 'preparing') return { phase: stage }
    if (stage === 'prepared' || stage === 'sleeping' || stage === 'failed')
      return { phase: 'prepared' as const, chapter: doc!.prepared!.chapter }
    return undefined
  })
}

export function AwakeSection(props: { onAct?: () => void }) {
  const current = useAwake()
  const [, openNext] = useDialog(nextDialog)
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const place = () => (props.onAct ? 'dream dialog' : 'dream sidebar')
  const openUltimate = () => talkToUltimate({ showSurface, switchConversation })
  const run = async (step: () => Promise<unknown>) => {
    const source = writerNow()
    setBusy(true)
    setFailure(undefined)
    try {
      await step()
      const onAct = props.onAct
      writingAs(source, () => onAct?.())
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  const ready = () =>
    run(async () => {
      const source = writerNow()
      await api.action(ReadyAction, null)
      await writingAs(source, openUltimate)
    })
  return (
    <Show when={current()}>
      {(awake) => (
        <section
          aria-label="Fall asleep"
          class="mx-2 mb-1.5 rounded-md border border-l-2 border-border/70 border-l-brand/60 bg-muted/30 px-2.5 py-2"
          data-dream-awake={awake().phase}
        >
          <p class="flex items-start gap-1.5 text-[12px] leading-snug">
            <MoonStarIcon class="mt-px size-3.5 shrink-0 text-brand" />
            <span class="text-foreground">
              {awake().phase === 'prepared'
                ? `Chapter ${awake().chapter} is ready`
                : awake().phase === 'preparing'
                  ? 'Preparing the next chapter'
                  : 'The dream is done'}
            </span>
          </p>
          <p class="mt-1 ml-5 text-[11.5px] leading-snug text-muted-foreground">
            {awake().phase === 'prepared'
              ? 'Fall asleep when you are ready: my handover carries the open work.'
              : awake().phase === 'preparing'
                ? '@ultimate is writing its handover; Fall asleep follows.'
                : 'Time to fall asleep: @ultimate writes its handover, then you confirm.'}
          </p>
          {failure() && (
            <p class="mt-1 ml-5 text-[11.5px] leading-snug text-error" role="alert">
              {failure()}
            </p>
          )}
          <div class="mt-1.5 ml-5 flex flex-wrap items-center gap-x-3 gap-y-1">
            {awake().phase === 'preparing' ? (
              <Button
                size={null}
                variant={null}
                aria-label={`Open @ultimate from the ${place()}`}
                class="flex items-center gap-1.5 font-mono text-[11px] font-normal text-foreground/85 hover:text-foreground"
                onClick={() => {
                  props.onAct?.()
                  return openUltimate().catch(meansNone)
                }}
                type="button"
              >
                <LoaderCircleIcon class="size-3 text-brand motion-safe:animate-spin" />
                Open @ultimate
              </Button>
            ) : (
              <Button
                size={null}
                variant={null}
                aria-label={`Continue to fall asleep in the ${place()}`}
                class="flex items-center gap-1.5 rounded-md border border-brand/50 px-2 py-0.5 text-[12px] font-normal text-foreground transition-colors outline-none hover:border-brand hover:bg-brand/10 focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
                data-dream-awake-asleep
                disabled={busy()}
                onClick={() => {
                  if (awake().phase !== 'prepared') return ready()
                  props.onAct?.()
                  return openNext(true)
                }}
                type="button"
              >
                {busy() ? (
                  <LoaderCircleIcon class="size-3 text-brand motion-safe:animate-spin" />
                ) : (
                  <MoonIcon class="size-3 text-brand" />
                )}
                Fall asleep…
              </Button>
            )}
            {awake().phase !== 'prepared' && (
              <Button
                size={null}
                variant={null}
                aria-label={`Stay in this chapter from the ${place()}`}
                class="font-mono text-[11px] font-normal text-muted-foreground hover:text-foreground"
                data-dream-awake-dismiss
                disabled={busy()}
                onClick={() => run(() => api.action(DismissAction, null))}
                type="button"
              >
                Stay in this chapter
              </Button>
            )}
          </div>
        </section>
      )}
    </Show>
  )
}
