/** @jsxImportSource @solidjs/web */
import { Zap } from '@lucide/solid'
import { createMemo, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
import { api, events, useAction, useAgent, useEvent } from '@/sdk/solid'
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
  const toggle = async () => {
    const { model, on } = fast()!
    await api.action(SetAction, { model, on: !on })
    events.emit('fast:changed', undefined)
  }
  return (
    <Show when={fast()}>
      {(state) => (
        <Tooltip>
          <TooltipTrigger
            render={(trigger) => (
              <Button
                {...trigger}
                aria-label="Fast mode"
                aria-pressed={state().on ? 'true' : 'false'}
                class="h-7 gap-1.5 px-2 font-mono text-[11.5px] font-normal text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:text-foreground/85"
                disabled={state().project}
                focusableWhenDisabled
                onClick={toggle}
                size={null}
                variant={null}
              />
            )}
          >
            <Zap class="size-3.5 in-aria-pressed:fill-brand/30 in-aria-pressed:text-brand" />
            <span class="@max-md:hidden">fast</span>
          </TooltipTrigger>
          <TooltipContent>{hint(state())}</TooltipContent>
        </Tooltip>
      )}
    </Show>
  )
}
