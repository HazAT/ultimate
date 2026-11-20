/** @jsxImportSource @solidjs/web */
import { AudioLines, Play, Square, Volume2, VolumeOff } from '@lucide/solid'
import { createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Checkbox } from '@/components/ui/checkbox.solid.tsx'
import { Popover, PopoverContent } from '@/components/ui/popover.solid.tsx'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control.solid.tsx'
import { Slider } from '@/components/ui/slider.solid.tsx'
import { StatusPopoverTrigger } from '@/components/ui/status-trigger.solid.tsx'
import { Switch } from '@/components/ui/switch.solid.tsx'
import { cn, useExtensionUiState, useNow } from '@/sdk/solid'
import * as conductor from './conductor.ts'
import { sounds } from './cues.ts'
import type { Sound } from './cues.ts'
import * as tones from './tones.ts'
import { variantOf, variants } from './variants.ts'

const preview = (sound: Sound) =>
  tones.play(sound).catch((error: unknown) => console.warn('Sound failed', error))

const row = 'flex h-8 items-center justify-between gap-2 px-2 text-[12px]'
const section = 'border-t border-border/70 pt-1'

export function Control() {
  const [muted, setMuted] = useExtensionUiState('muted', false)
  const [off, setOff] = useExtensionUiState<Sound[]>('off', [])
  const volume = useExtensionUiState('volume', 0.8)
  const [stored, setAgents] = useExtensionUiState('agents', 'off')
  const narrator = useExtensionUiState('narrator', false)
  const branches = useExtensionUiState('narrateBranches', false)
  const variant = createMemo(() => variantOf(stored()))
  const playing = () => !!variant() && !muted()
  const [stage, setStage] = createSignal(conductor.current())
  onSettled(() => {
    const update = () => setStage(conductor.current())
    const unsubscribe = conductor.subscribe(update)
    update()
    return unsubscribe
  })
  const demoUntil = () => stage().demoUntil
  const demoing = () => demoUntil() !== undefined
  const now = useNow(1000, demoing)
  const demoLabel = () => (demoing() ? 'Stop demo' : 'Start demo')
  const demoTime = () => {
    const until = demoUntil()
    return until === undefined ? '40s' : `${Math.max(0, Math.ceil((until - now()) / 1000))}s`
  }
  return (
    <Popover>
      <StatusPopoverTrigger
        aria-label="Sound settings"
        class={cn(muted() && 'text-muted-foreground/60', playing() && 'text-brand')}
      >
        {muted() ? (
          <VolumeOff class="size-3" />
        ) : playing() ? (
          <AudioLines class="size-3 animate-pulse" />
        ) : (
          <Volume2 class="size-3" />
        )}
        sounds
      </StatusPopoverTrigger>
      <PopoverContent align="end" class="w-64 p-1 font-mono" side="top">
        <label class={row}>
          Sounds
          <Switch bind={[() => !muted(), (on) => setMuted(!on)]} />
        </label>
        <label class={cn(row, muted() && 'opacity-50')}>
          <span class="text-muted-foreground">Volume</span>
          <Slider
            aria-label="Volume"
            bind={volume}
            disabled={muted()}
            max={1}
            min={0}
            step={0.05}
          />
        </label>
        <div class={cn(section, muted() && 'opacity-50')}>
          <label class={row}>
            Narrator
            <Switch bind={narrator} disabled={muted()} />
          </label>
          <Show when={narrator[0]()}>
            <label class="flex h-7 items-center gap-2 px-2 text-[12px]">
              <Checkbox bind={branches} disabled={muted()} />
              Announce new branches
            </label>
            <div class="px-2 pt-0.5 pb-1 text-[11px] leading-4 text-muted-foreground">
              Speaks questions, failures and landings after their sound, also while the tab is
              hidden. OpenAI receives branch titles when that voice is used.
            </div>
          </Show>
        </div>
        <div class={cn(section, muted() && 'opacity-50')}>
          <label class={row}>
            Sound of agents
            <Switch
              bind={[() => !!variant(), (on) => setAgents(on ? 'chiptune' : 'off')]}
              disabled={muted()}
            />
          </label>
          <Show when={variant()}>
            {(selected) => (
              <>
                <SegmentedControl
                  aria-label="Variant"
                  bind={[() => selected().id, setAgents]}
                  class="mx-2 mb-1 grid grid-cols-3 p-px"
                  disabled={muted()}
                >
                  <For each={variants}>
                    {(option) => (
                      <SegmentedControlItem
                        class="justify-center rounded-[5px] px-0 data-disabled:opacity-100"
                        title={option.detail}
                        value={option.id}
                      >
                        {option.label}
                      </SegmentedControlItem>
                    )}
                  </For>
                </SegmentedControl>
                <div class="px-2 pb-1 text-[11px] leading-4 text-muted-foreground">
                  {selected().detail}
                </div>
                <Button
                  aria-label={demoLabel()}
                  class={cn(
                    row,
                    'w-full rounded-sm py-0 font-normal data-disabled:opacity-100',
                    demoing() && 'text-brand',
                  )}
                  disabled={muted()}
                  onClick={() => (demoing() ? conductor.stopDemo() : conductor.startDemo())}
                  size="sm"
                  variant="ghost"
                >
                  <span class="flex items-center gap-2">
                    {demoing() ? <Square class="size-3" /> : <Play class="size-3" />}
                    {demoLabel()}
                  </span>
                  <span class="text-[11px] text-muted-foreground">{demoTime()}</span>
                </Button>
                <Show when={stage().blocked}>
                  <div class="px-2 pb-1 text-[11px] text-warning">
                    Click anywhere to start audio
                  </div>
                </Show>
              </>
            )}
          </Show>
        </div>
        <div class={section}>
          <For each={sounds}>
            {({ sound, label }) => (
              <div
                class={cn('flex h-7 items-center gap-2 px-2 text-[12px]', muted() && 'opacity-50')}
              >
                <label class="flex flex-1 items-center gap-2">
                  <Checkbox
                    aria-label={`Sound on for ${label}`}
                    bind={[
                      () => !off().includes(sound),
                      (on) => {
                        setOff((previous) =>
                          on ? previous.filter((other) => other !== sound) : [...previous, sound],
                        )
                        if (on) void preview(sound)
                      },
                    ]}
                    disabled={muted()}
                  />
                  {label}
                </label>
                <Button
                  aria-label={`Play ${label}`}
                  class="size-5 rounded-sm text-muted-foreground"
                  onClick={() => void preview(sound)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <Play class="size-3" />
                </Button>
              </div>
            )}
          </For>
          <div class="px-2 pt-0.5 pb-1 text-[11px] text-muted-foreground">
            Landings from any branch; the rest from @ultimate only
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
