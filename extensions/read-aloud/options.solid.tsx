import { For, Show } from 'solid-js'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control.solid.tsx'
import { Slider } from '@/components/ui/slider.solid.tsx'
import { speech } from './voice.solid.tsx'
import { VOICES } from './voices.shared.ts'

const speed = () => `${Number(speech.rate().toFixed(2))}×`

export function SpeechSettings(props: { name: string }) {
  const named = (label: string) => `${label} in ${props.name}`
  return (
    <Popover>
      <PopoverTrigger
        aria-label={named('Speech settings')}
        class="shrink-0 rounded px-1 font-mono text-[11px] text-muted-foreground tabular-nums transition-colors hover:text-foreground data-open:text-foreground"
        title="Voice and speed"
      >
        {speed()}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={named('Speech settings options')}
        class="w-64 p-0 font-mono text-[11.5px]"
        initialFocus="none"
        side="top"
      >
        <div class="px-3 pt-2.5 pb-1 section-label">Speech</div>
        <div class="flex flex-col gap-2.5 px-3 pt-1 pb-2.5 text-muted-foreground">
          <SpeechOptions name={props.name} />
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function SpeechOptions(props: { name: string }) {
  const named = (label: string) => `${label} in ${props.name}`
  const keyed = () => speech.keyed() === true
  const voiceNote = () => {
    const needsKey = speech.keyed() === false && 'OpenAI voice needs OPENAI_API_KEY in ⌘K → Secrets'
    if (speech.voiced()) return needsKey
    if (needsKey) return `No system voices in this browser. ${needsKey}`
    return keyed() && 'No system voices in this browser · speaking with OpenAI'
  }
  return (
    <>
      <div class="flex flex-col gap-2">
        <div class="flex items-center justify-between gap-3">
          Voice
          <SegmentedControl
            aria-label={named('Speech voice')}
            bind={[() => (speech.openaiOn() ? 'openai' : 'system'), speech.setVoice]}
          >
            <SegmentedControlItem disabled={!speech.voiced()} value="system">
              System
            </SegmentedControlItem>
            <SegmentedControlItem disabled={!keyed()} value="openai">
              OpenAI
            </SegmentedControlItem>
          </SegmentedControl>
        </div>
        <Show when={voiceNote()}>
          {(note) => (
            <span class="text-[10.5px] leading-snug text-muted-foreground/70">{note()}</span>
          )}
        </Show>
        <Show when={speech.openaiOn()}>
          <SegmentedControl
            aria-label={named('OpenAI voice')}
            bind={[speech.openaiVoice, speech.setOpenaiVoice]}
            class="grid grid-cols-5"
          >
            <For each={VOICES}>
              {(name) => (
                <SegmentedControlItem class="justify-center" value={name}>
                  {name}
                </SegmentedControlItem>
              )}
            </For>
          </SegmentedControl>
        </Show>
      </div>
      <label class="flex items-center justify-between gap-3">
        Speed
        <span class="flex items-center gap-2">
          <Slider
            aria-label={named('Speech speed')}
            bind={[speech.rate, speech.setRate]}
            class="w-24"
            max={2}
            min={0.8}
            step={0.05}
          />
          <span class="w-9 text-right text-foreground/85 tabular-nums">{speed()}</span>
        </span>
      </label>
    </>
  )
}
