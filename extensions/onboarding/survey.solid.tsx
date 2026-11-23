import { Compass, LoaderCircle, X } from '@lucide/solid'
import { createMemo, createSignal, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  api,
  column,
  errorMessage,
  ROOT,
  useAction,
  useAgent,
  useConversationId,
  useDialog,
  useDocOf,
  useModels,
  useSystem,
} from '@/sdk/solid'
import type { SolidComposerProps } from '@/sdk/solid'
import { MemoryDoc, RootsDoc } from '../lineage/refs.ts'
import { StandingDoc } from '../subagents/refs.ts'
import { firstRunDialog } from './dialogs.ts'
import { onboarded } from './onboarded.ts'
import { DismissAction, StartAction, StartsDoc, StatusAction } from './refs.ts'

export function StartComposer(props: SolidComposerProps) {
  const id = useConversationId()
  const standing = useDocOf(() => ROOT, StandingDoc)
  const ours = () => id() !== undefined && id() === standing()?.ultimate
  return (
    <>
      <Show when={ours()}>
        <StartHere dock={props.dock} />
      </Show>
      {props.core}
    </>
  )
}

function StartHere(props: { dock?: boolean }) {
  const roots = useDocOf(() => ROOT, RootsDoc)
  const root = () => roots()?.roots[0]
  const starts = useDocOf(() => ROOT, StartsDoc)
  const memories = useDocOf(() => root() ?? ROOT, MemoryDoc)
  const system = useSystem()
  const status = useAction(StatusAction, null, { conversation: ROOT })
  const models = useModels()
  const agent = useAgent()
  const [, openGetReady] = useDialog(firstRunDialog)
  const [sending, setSending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const runnable = createMemo(() => {
    const model = agent().model
    return !!models()?.models.some(
      (candidate) =>
        candidate.provider === model?.provider &&
        candidate.id === model.modelId &&
        candidate.available,
    )
  })
  const shown = createMemo(() => {
    const at = root()
    const started = starts()
    const known = memories()
    const current = status.data()
    if (at === undefined || started === undefined || known === undefined || !current)
      return undefined
    if (current.off || started?.dismissed || onboarded(started?.roots[String(at)], known))
      return undefined
    return at
  })
  const run = (action: () => Promise<unknown>) => {
    setSending(true)
    setError(undefined)
    return action()
      .catch((failure: unknown) => setError(errorMessage(failure)))
      .finally(() => setSending(false))
  }
  return (
    <Show when={shown()}>
      {(at) => (
        <div class={[column(props.dock), 'pb-2']}>
          <div
            class="flex flex-wrap items-center gap-x-3 gap-y-2.5 rounded-lg border border-brand/30 bg-brand/5 px-3.5 py-3"
            data-onboarding-start={at()}
          >
            <Compass class="size-4 shrink-0 text-brand" />
            <div class="min-w-0 flex-1 basis-60">
              <p class="text-[13.5px] font-medium text-foreground">
                Let Ultimate get familiar with {system()?.project.name ?? 'the project'}
              </p>
              <p class="text-[12.5px] leading-snug text-muted-foreground">
                {error() ??
                  '@ultimate walks you through how it works, helps you choose your setup and reads the project.'}
              </p>
            </div>
            <div class="ml-auto flex items-center gap-1">
              <Button
                disabled={sending()}
                onClick={() =>
                  runnable()
                    ? run(() => api.action(StartAction, { root: at() }))
                    : openGetReady(true)
                }
              >
                <Show when={sending()} fallback={<Compass />}>
                  <LoaderCircle class="motion-safe:animate-spin" />
                </Show>
                Set up with @ultimate
              </Button>
              <Button
                aria-label="Dismiss setup"
                class="text-muted-foreground hover:text-foreground"
                disabled={sending()}
                onClick={() => run(() => api.action(DismissAction))}
                size="icon-sm"
                title="Not now. ⌘K Get ready… starts setup later."
                variant="ghost"
              >
                <X />
              </Button>
            </div>
          </div>
        </div>
      )}
    </Show>
  )
}
