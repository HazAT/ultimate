import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { Mic } from '@lucide/solid'
import { createEffect, createMemo, For, Show } from 'solid-js'
import { Message, MessageContent } from '@/components/ai/message.solid.tsx'
import { Shimmer } from '@/components/ai/shimmer.solid.tsx'
import { ToolImage } from '@/components/ai/tool.solid.tsx'
import {
  MessageActions,
  ROOT,
  useConversation,
  useConversationId,
  useDocOf,
  useTranscriptElements,
  UserText,
} from '@/sdk/solid'
import { drawWave } from '../dictation/ui.solid.tsx'
import {
  dock,
  imagesIn,
  imagesOf,
  playerState,
  replyOf,
  settleTranscripts,
  sideChatShown,
  turnsIn,
  useSpeaking,
  useTurns,
} from './dock.solid.tsx'
import { LegacyVoiceForkDoc, LegacyVoiceTurnEntry, SideChatTurnEntry } from './entries.shared.ts'
import { SideChatForkDoc, SideChatSessionDoc } from './refs.ts'
import type { SideChatFork, SideChatTurn } from './refs.ts'
import { splitReply, useSpokenText } from '../read-aloud/ui.solid.tsx'

const short = (key: string) => key.slice(0, 8)

export const timeOf = (entry: EntryRecord) => {
  const message = entry.model?.[0]
  return message && 'timestamp' in message ? message.timestamp : 0
}

function Waveform(props: { envelope?: readonly number[]; class?: string }) {
  let canvas: HTMLCanvasElement | undefined
  const color = () => getComputedStyle(canvas!).color
  createEffect(
    () => props.envelope,
    (envelope) => {
      if (canvas && envelope) drawWave(canvas, envelope, color(), false)
    },
  )
  return <canvas aria-hidden="true" class={props.class} height={56} ref={canvas} width={440} />
}

export function saidIn(
  data: SideChatTurn,
  recording: string | undefined,
  stored: boolean,
  transcripts: Record<string, string> | undefined,
) {
  if (!data.audio || (stored && data.route === 'text')) return data.text
  const heard = recording ? transcripts?.[recording] : undefined
  if (heard !== undefined) return [heard, data.text].filter(Boolean).join('\n\n')
  return data.text || undefined
}

const streaming = ':scope > [data-from="assistant"]'

function useSpokenReply(key: () => string) {
  const conversation = useConversation()
  const transcript = useTranscriptElements()
  const spoken = createMemo(() => playerState().key === key())
  const turn = createMemo(() =>
    spoken() ? turnsIn(conversation()).turns.find((each) => each.key === key()) : undefined,
  )
  const sentences = createMemo(() => {
    const shown = turn()
    if (!shown) return []
    const parts = replyOf(shown).parts
    return splitReply(conversation().busy ? parts : parts.map((part) => ({ ...part, final: true })))
      .sentences
  })
  const replies = () => {
    const content = transcript.content()
    const shown = turn()
    if (!content || !shown) return []
    const rows = shown.entries.flatMap((id) => [
      ...content.querySelectorAll(`[data-entry-id="${id}"]`),
    ])
    const live = shown.live ? [...content.querySelectorAll(streaming)] : []
    return [...rows, ...live].filter(
      (element, _index, all) => !all.some((other) => other !== element && other.contains(element)),
    )
  }
  useSpokenText(replies, () =>
    spoken()
      ? {
          key: key(),
          spans: sentences().map((sentence) => sentence.text),
          play: (index) => {
            dock.player.load(key(), sentences(), conversation().busy)
            dock.player.play(index)
          },
        }
      : undefined,
  )
}

export function SideChatTurnView(props: {
  turn: {
    key: string
    data: SideChatTurn
    images: readonly { data: string; mimeType: string }[]
  }
  record?: EntryRecord
  submitted?: boolean
  conversation: ConversationId | undefined
}) {
  const data = () => props.turn.data
  const archived = () =>
    props.record && LegacyVoiceTurnEntry.is(props.record) ? props.record.data : undefined
  const fork = useDocOf(() => (archived() ? undefined : props.conversation), SideChatForkDoc)
  const legacy = useDocOf(
    () => (archived() && data().audio && !data().text ? props.conversation : undefined),
    LegacyVoiceForkDoc,
  )
  const local = () => dock.local()[props.turn.key]
  const audio = () => (data().audio === 'pending' ? local()?.audio : data().audio)
  const said = () => {
    const old = archived()
    if (!old) return saidIn(data(), audio(), props.submitted ?? !!props.record, fork()?.transcripts)
    if (old.text || !old.audio) return old.text
    const transcripts = legacy()?.transcripts
    return (old.clips ?? [old.audio])
      .map((clip) => transcripts?.[clip])
      .filter(Boolean)
      .join(' ')
  }
  const failed = () => {
    const recording = audio()
    return local()?.failed ?? (recording ? fork()?.failed?.[recording] : undefined)
  }
  useSpokenReply(() => props.turn.key)
  return (
    <Message class="group/message mt-3 first:mt-0" data-side-chat-turn={props.turn.key} from="user">
      <MessageContent>
        <Show when={data().audio}>
          <div class="flex min-w-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <span class="inline-flex shrink-0 items-center gap-1 tabular-nums">
              <Mic class="size-3" />
              {data().seconds?.toFixed(1)} s
            </span>
            <Show when={data().envelope}>
              <Waveform
                class="h-4 w-28 min-w-0 shrink text-muted-foreground/70"
                envelope={data().envelope}
              />
            </Show>
            <Show when={!archived() && said() !== undefined && !failed()}>
              <span class="truncate text-muted-foreground/60">
                {data().route === 'audio' ? 'the model hears your voice' : 'the model reads this'}
              </span>
            </Show>
          </div>
        </Show>
        <Show
          when={!failed()}
          fallback={
            <p class="font-mono text-[12px] text-error">
              {data().audio ? 'Transcription failed: ' : 'Not sent: '}
              {failed()}
            </p>
          }
        >
          <Show
            when={said()}
            fallback={
              <Show when={data().audio}>
                <Show
                  when={said() === undefined}
                  fallback={
                    <span class="font-mono text-[12px] text-muted-foreground">
                      {archived() ? 'Transcript unavailable' : 'no words heard in the transcript'}
                    </span>
                  }
                >
                  <Shimmer class="font-mono text-[12px]">transcribing…</Shimmer>
                </Show>
              </Show>
            }
          >
            {(text) => (
              <UserText at={props.record ? timeOf(props.record) : undefined} text={text()} />
            )}
          </Show>
        </Show>
        <Show when={props.turn.images.length}>
          <div class="flex flex-wrap gap-2">
            <For each={props.turn.images}>
              {(image, index) => (
                <ToolImage
                  alt={`Screenshot ${index() + 1} of turn ${short(props.turn.key)}`}
                  image={image}
                />
              )}
            </For>
          </div>
        </Show>
      </MessageContent>
      <Show when={props.record}>
        {(record) => (
          <MessageActions
            class="-mt-1 justify-end"
            entry={record()}
            text={said() ?? ''}
            timestamp={timeOf(record())}
          />
        )}
      </Show>
    </Message>
  )
}

export function StoredTurn(props: { entry: EntryRecord & { data: SideChatTurn } }) {
  const turn = createMemo(() => ({
    key: props.entry.data.key,
    data: props.entry.data,
    images: imagesOf(props.entry),
  }))
  return (
    <SideChatTurnView
      conversation={props.entry.conversationId}
      record={props.entry}
      turn={turn()}
    />
  )
}

export function PendingTurns() {
  const id = useConversationId()
  const session = useDocOf(() => ROOT, SideChatSessionDoc)
  const conversation = useConversation()
  const pending = createMemo(() => {
    const here = id()
    if (
      here === undefined ||
      !Object.values(session()?.sessions ?? {}).some((each) => each?.id === here)
    )
      return []
    const state = conversation()
    const candidates = [
      ...Object.entries(dock.local()).flatMap(([key, each]) =>
        each.optimistic && (each.conversation === undefined || each.conversation === here)
          ? [
              {
                key,
                data: each.optimistic,
                images: each.images ?? [],
                submitted: false,
              },
            ]
          : [],
      ),
      ...state.inbox.flatMap((item) =>
        item.mode !== 'write' && item.entry?.kind === SideChatTurnEntry.kind
          ? [
              {
                key: (item.entry.data as SideChatTurn).key,
                data: item.entry.data as SideChatTurn,
                images: imagesIn(item.content),
                submitted: true,
              },
            ]
          : [],
      ),
    ]
    if (!candidates.length) return []
    const shown = new Set(
      state.entries.flatMap((entry) => (SideChatTurnEntry.is(entry) ? [entry.data.key] : [])),
    )
    return candidates.filter((turn) => !shown.has(turn.key) && !!shown.add(turn.key))
  })
  return (
    <For each={pending()} keyed={(turn) => turn.key}>
      {(turn) => (
        <div class="empty-row" data-side-chat-pending={turn().key}>
          <SideChatTurnView conversation={id()} submitted={turn().submitted} turn={turn()} />
        </div>
      )}
    </For>
  )
}

export function Voicing(props: { fork: ConversationId }) {
  const fork = useDocOf(() => props.fork, SideChatForkDoc)
  createEffect(
    () => {
      const doc = fork()
      return doc
        ? ({
            ...doc,
            transcripts: { ...doc.transcripts },
            failed: { ...doc.failed },
          } as SideChatFork)
        : doc
    },
    (doc) => settleTranscripts(doc, props.fork),
  )
  useSpeaking(useTurns(), sideChatShown)
  return null
}
