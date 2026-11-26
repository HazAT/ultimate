import { Settings2 } from '@lucide/solid'
import { createSignal } from 'solid-js'
import { Button, buttonVariants } from '@/components/ui/button.solid.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control.solid.tsx'
import { cn, formatKeys } from '@/sdk/solid'
import { Switch } from '@/components/ui/switch.solid.tsx'
import {
  keyChord,
  setShortcut,
  setSoundCues,
  setTalkMode,
  shortcut,
  soundCues,
  talkMode,
} from './routing.solid.tsx'

export function DictationSettings(props: { name: string }) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Dictation settings for ${props.name}`}
        class={cn(
          buttonVariants({ size: null, variant: 'ghost' }),
          'size-6 rounded-md text-muted-foreground data-open:bg-accent pointer-coarse:size-9',
        )}
        onPointerDown={(event) => event.preventDefault()}
        title="Dictation settings"
      >
        <Settings2 class="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={`Dictation settings options for ${props.name}`}
        class="w-64 p-0 font-mono text-[11.5px]"
        initialFocus="none"
        side="top"
      >
        <div class="px-3 pt-2.5 pb-1 section-label">Dictation</div>
        <div class="flex flex-col gap-2.5 px-3 pt-1 pb-2.5 text-muted-foreground">
          <div class="flex items-center justify-between gap-3">
            Talk
            <SegmentedControl
              aria-label={`Talk mode for ${props.name}`}
              bind={[talkMode, setTalkMode]}
            >
              <SegmentedControlItem value="hold">Hold</SegmentedControlItem>
              <SegmentedControlItem value="tap">Tap</SegmentedControlItem>
            </SegmentedControl>
          </div>
          <div class="flex items-center justify-between gap-3">
            Talk shortcut
            <ShortcutRecorder name={props.name} />
          </div>
          <div class="flex items-center justify-between gap-3">
            Sound cues
            <Switch
              aria-label={`Dictation sound cues for ${props.name}`}
              bind={[soundCues, setSoundCues]}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ShortcutRecorder(props: { name: string }) {
  const [listening, setListening] = createSignal(false)
  const record = (event: KeyboardEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      setListening(false)
      return
    }
    const chord = keyChord(event)
    const hasKey = !['mod', 'ctrl', 'alt', 'shift'].includes(chord.split('+').at(-1)!)
    const hasModifier = chord.includes('+')
    if (!hasKey || !hasModifier) return
    setShortcut(chord)
    setListening(false)
  }
  return (
    <Button
      aria-label={`Talk shortcut for ${props.name}`}
      class={cn(
        'flex h-6 items-center gap-1 rounded-md border border-border/70 px-1.5 font-mono text-[11px] font-normal text-foreground/85 hover:bg-accent',
        listening() && 'border-brand/60 text-brand',
      )}
      data-dictation-shortcut-recorder={listening() ? '' : undefined}
      onBlur={() => setListening(false)}
      onClick={() => setListening(true)}
      onKeyDown={(event: KeyboardEvent) => listening() && record(event)}
      size={null}
      title="Click, then press a key with a modifier (Ctrl, Alt, Shift); Esc cancels"
      variant={null}
    >
      {listening() ? 'press keys…' : formatKeys(shortcut())[0].join('+')}
    </Button>
  )
}
