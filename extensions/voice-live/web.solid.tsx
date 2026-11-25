import { AudioLinesIcon, ChevronRight, Mic, SquareArrowOutUpRightIcon } from '@lucide/solid'
import { For, Show } from 'solid-js'
import { Message, MessageContent } from '@/components/ai/message.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import {
  Card,
  defineWebExtension,
  MessageActions,
  provide,
  renderEntry,
  switchConversation,
  useDocOf,
  UserText,
} from '@/sdk/solid'
import { VoiceHandoffEntry, VoiceTurnEntry } from './entries.ts'
import { VoiceForkDoc } from './refs.ts'
import { KEYS, setVoiceOpen, voiceOpen } from './dock.solid.tsx'
import { VoicePanel, VoiceToggle } from './panel.solid.tsx'
import { VoiceRow, voiceForks } from './row.solid.tsx'
import { UnderUltimate, Unlisted } from '../sidebar/ui.solid.tsx'
import { timeOf } from './turns.solid.tsx'

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
        <Show when={data().words?.length}>
          <Collapsible class="group/voice-words mt-2">
            <CollapsibleTrigger
              aria-label={`Your words in handoff #${props.entry.id}`}
              class="flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
            >
              <ChevronRight class="size-3 transition-transform group-data-open/voice-words:rotate-90" />
              Your words · {data().words!.length}
              {data().earlier ? ` (${data().earlier} earlier left out)` : ''}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <For each={data().words}>
                {(said) => (
                  <blockquote class="mt-1 border-l-2 border-border pl-2 whitespace-pre-wrap text-muted-foreground">
                    {said}
                  </blockquote>
                )}
              </For>
            </CollapsibleContent>
          </Collapsible>
        </Show>
      </div>
    </Card>
  )
})

const TurnRow = renderEntry(VoiceTurnEntry, function TurnRow(props) {
  const data = () => props.entry.data
  const fork = useDocOf(() => props.entry.conversationId, VoiceForkDoc)
  const said = () => {
    if (data().route !== 'audio') return data().text
    const clips = data().clips ?? (data().audio ? [data().audio!] : [])
    const heard = clips.map((clip) => fork()?.transcripts?.[clip]).filter(Boolean)
    return [heard.join(' '), data().text].filter(Boolean).join('\n\n')
  }
  const text = () => said() || data().text || '(no transcript)'
  return (
    <Message class="group/message mt-3 first:mt-0" from="user">
      <MessageContent>
        <Show when={data().audio}>
          <span class="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground tabular-nums">
            <Mic class="size-3" />
            {data().seconds?.toFixed(1)} s
          </span>
        </Show>
        <UserText at={timeOf(props.entry)} text={text()} />
      </MessageContent>
      <MessageActions
        class="-mt-1 justify-end"
        entry={props.entry}
        text={text()}
        timestamp={timeOf(props.entry)}
      />
    </Message>
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
  provides: [provide(UnderUltimate, VoiceRow), provide(Unlisted, voiceForks)],
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
