/** @jsxImportSource @solidjs/web */
import { Brain, Cpu } from '@lucide/solid'
import { createMemo, Show } from 'solid-js'
import { useTranscript } from '@/sdk/solid'
import type { SolidEntryProps } from '@/sdk/solid'
import { switchAt } from './switches.ts'

export function Switched(props: SolidEntryProps) {
  const transcript = useTranscript()
  const modelSwitch = createMemo(() => switchAt(transcript(), props.entry))
  return (
    <Show when={modelSwitch()} fallback={props.core}>
      {(change) => (
        <div class="flex flex-col gap-3">
          <div
            class="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/70 before:h-px before:flex-1 before:bg-border/70 after:h-px after:flex-1 after:bg-border/70"
            data-models-switch
            title="The model and thinking level from this response on"
          >
            <span class="flex max-w-[80%] min-w-0 items-center gap-1.5">
              <Show when={change().model} fallback={<Brain class="size-3 shrink-0" />}>
                <Cpu class="size-3 shrink-0" />
              </Show>
              <span class="truncate">
                {[
                  change().model && `${change().model?.from} → ${change().model?.to}`,
                  change().thinking &&
                    `thinking ${change().thinking?.from} → ${change().thinking?.to}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
          </div>
          {props.core}
        </div>
      )}
    </Show>
  )
}
