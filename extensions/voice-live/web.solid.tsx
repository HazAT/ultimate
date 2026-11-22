import { AudioLinesIcon, SquareArrowOutUpRightIcon } from '@lucide/solid'
import { For, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Card, defineWebExtension, renderEntry, switchConversation } from '@/sdk/solid'
import { VoiceHandoffEntry, VoiceTurnEntry } from './entries.ts'
import { KEYS, setVoiceOpen, voiceOpen, VoicePanel, VoiceToggle } from './dock.solid.tsx'

const HandoffCard = renderEntry(VoiceHandoffEntry, function HandoffCard(props) {
  const data = () => props.entry.data
  const section = (label: string, items: readonly string[] | undefined) => (
    <Show when={items?.length}>
      <div class="mt-2 font-mono text-[11px] text-muted-foreground">{label}</div>
      <ul class="mt-0.5 list-disc pl-4">
        <For each={items}>{(item) => <li>{item}</li>}</For>
      </ul>
    </Show>
  )
  return (
    <Card data-voice-handoff={props.entry.id}>
      <header class="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <AudioLinesIcon class="size-3.5 text-brand" />
        <span class="text-foreground">Voice</span>
        <span>handoff</span>
        <span class="truncate text-foreground">{data().title}</span>
        <Button
          aria-label={`Read voice session #${data().from} from handoff #${props.entry.id}`}
          class="ml-auto flex gap-1 rounded-none font-mono text-[11px] font-normal hover:text-foreground"
          onClick={() => switchConversation(data().from)}
          size={null}
          title={`Read voice session #${data().from}`}
          variant={null}
        >
          <SquareArrowOutUpRightIcon class="size-3" />
          voice session
        </Button>
      </header>
      <div class="min-w-0 px-3 py-2.5 text-[13px] leading-relaxed">
        <p>{data().outcome}</p>
        {section('Decided', data().decided)}
        {section('Open', data().open)}
        {section('Screenshots', data().attachments)}
        <div class="mt-2 font-mono text-[11px] text-muted-foreground">Instruction</div>
        <p class="mt-0.5">{data().instruction}</p>
      </div>
    </Card>
  )
})

const TurnRow = renderEntry(VoiceTurnEntry, function TurnRow(props) {
  const data = () => props.entry.data
  return (
    <div class="ml-auto max-w-[85%] rounded-xl border border-brand/15 bg-brand/5 px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap">
      <span class="mr-1.5 font-mono text-[11px] text-muted-foreground">
        {data().audio ? `🎙 ${data().seconds?.toFixed(1) ?? ''} s` : '⌨'}
      </span>
      {data().text || '(no transcript)'}
    </div>
  )
})

export default defineWebExtension({
  slots: {
    'titlebar.right': [VoiceToggle],
    overlay: [VoicePanel],
  },
  entries: {
    'voice.handoff': HandoffCard,
    'voice.turn': TurnRow,
  },
  tools: { voice_handoff: () => null },
  commands: [
    {
      id: 'voice-live.toggle',
      title: 'Voice: open or hide',
      keys: KEYS,
      run: () => setVoiceOpen(!voiceOpen()),
    },
  ],
})
