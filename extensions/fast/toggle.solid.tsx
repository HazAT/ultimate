/** @jsxImportSource @solidjs/web */
import { Zap } from '@lucide/solid'
import { createMemo, createSignal, Show } from 'solid-js'
import { Toggle } from '@/components/ui/toggle.solid.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
import { api, errorMessage, events, useAction, useAgent, useEvent } from '@/sdk/solid'
import { SetAction, StatusAction } from './refs.ts'

const fastProviders = new Set(['openai-codex', 'openai'])

const hint = (fast: { modelId: string; on: boolean; project: boolean }) =>
  fast.project
    ? 'Fast models are set by project settings'
    : fast.on
      ? `Fast for every ${fast.modelId} request · uses plan limits 2.5× faster · click for Standard`
      : `Standard speed · click to run every ${fast.modelId} request fast`

export function FastToggle() {
  const agent = useAgent()
  const status = useAction(StatusAction)
  useEvent('fast:changed', () => void status.refetch())
  const fast = createMemo(() => {
    const ref = agent().model
    const data = status.data()
    if (!ref || !fastProviders.has(ref.provider) || !data) return undefined
    const model = `${ref.provider}/${ref.modelId}`
    return { model, modelId: ref.modelId, on: data.models.includes(model), project: data.project }
  })
  const [error, setError] = createSignal<string>()
  let changing = false
  const toggle = async (on: boolean) => {
    if (changing) return
    changing = true
    setError(undefined)
    const { model } = fast()!
    try {
      await api.action(SetAction, { model, on })
      events.emit('fast:changed', undefined)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      changing = false
    }
  }
  return (
    <Show when={fast()}>
      {(state) => (
        <Tooltip>
          <TooltipTrigger
            render={(trigger) => (
              <Toggle
                {...trigger}
                aria-label="Fast mode"
                pressed={state().on}
                class="h-7 gap-1.5 px-2 font-mono text-[11.5px] font-normal text-muted-foreground hover:bg-accent hover:text-foreground data-pressed:bg-transparent data-pressed:text-foreground/85 data-pressed:hover:bg-accent"
                disabled={state().project}
                focusableWhenDisabled
                onPressedChange={(on) => void toggle(on)}
                size={null}
                variant={null}
              />
            )}
          >
            <Zap class="size-3.5 in-data-pressed:fill-brand/30 in-data-pressed:text-brand" />
            <span class="@max-md:hidden">fast</span>
          </TooltipTrigger>
          <TooltipContent>{error() ?? hint(state())}</TooltipContent>
        </Tooltip>
      )}
    </Show>
  )
}
