import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { MessageCircleReply, Mic } from '@lucide/solid'
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show } from 'solid-js'
import { Message, MessageContent } from '@/components/ai/message.solid.tsx'
import { Shimmer } from '@/components/ai/shimmer.solid.tsx'
import { ToolImage } from '@/components/ai/tool.solid.tsx'
import {
  MessageActions,
  ROOT,
  useConversation,
  useConversationId,
  useDocOf,
  UserText,
} from '@/sdk/solid'
import { capture, drawWave } from '../dictation/ui.solid.tsx'
import {
  dock,
  imagesIn,
  imagesOf,
  playerState,
  replyOf,
  setActivity,
  settleTranscripts,
  turnsIn,
  useSpeaking,
  useTurns,
} from './dock.solid.tsx'
import { VoiceTurnEntry } from './entries.shared.ts'
import { VoiceForkDoc, VoiceSessionDoc } from './refs.ts'
import type { VoiceFork, VoiceTurn } from './refs.ts'
import { splitReply, useSpokenText } from '../read-aloud/ui.solid.tsx'

const short = (key: string) => key.slice(0, 8)

export const timeOf = (entry: EntryRecord) => {
  const message = entry.model?.[0]
  return message && 'timestamp' in message ? message.timestamp : 0
}

export function Waveform(props: { envelope?: readonly number[]; live?: boolean; class?: string }) {
  let canvas: HTMLCanvasElement | undefined
  const color = () => getComputedStyle(canvas!).color
  createEffect(
    () => props.envelope,
    (envelope) => {
      if (canvas && envelope) drawWave(canvas, envelope, color(), false)
    },
  )
  onSettled(() => {
    if (!props.live) return undefined
    return capture.onLevel(() => canvas && drawWave(canvas, capture.levels(), color(), true))
  })
  return <canvas aria-hidden="true" class={props.class} height={56} ref={canvas} width={440} />
}

export function saidIn(
  data: VoiceTurn,
  recording: string | undefined,
  stored: boolean,
  transcripts: Record<string, string> | undefined,
) {
  if (!data.audio || (stored && data.route === 'text')) return data.text
  const clips = data.clips ?? (recording ? [recording] : [])
  const heard = clips.map((clip) => transcripts?.[clip])
  if (clips.length && heard.every((text) => text !== undefined))
    return [heard.filter(Boolean).join(' '), data.text].filter(Boolean).join('\n\n')
  return data.text || undefined
}

const row = '[data-entry-id]'
const answer = '[data-from="assistant"]'

function useSpokenReply(key: () => string, turnRow: () => Element | undefined) {
  const conversation = useConversation()
  const spoken = createMemo(() => playerState().key === key())
  const sentences = createMemo(() => {
    if (!spoken()) return []
    const state = conversation()
    const turn = turnsIn(state).turns.find((each) => each.key === key())
    if (!turn) return []
    const parts = replyOf(turn).parts
    return splitReply(state.busy ? parts : parts.map((part) => ({ ...part, final: true })))
      .sentences
  })
  const replies = () => {
    const rows: Element[] = []
    for (let next = turnRow()?.nextElementSibling; next; next = next.nextElementSibling) {
      if (next.querySelector('[data-voice-turn]')) break
      if (next.matches(answer) || next.querySelector(answer)) rows.push(next)
    }
    return rows
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

export function VoiceTurnView(props: {
  turn: { key: string; data: VoiceTurn; images: readonly { data: string; mimeType: string }[] }
  record?: EntryRecord
  submitted?: boolean
  conversation: ConversationId | undefined
}) {
  const data = () => props.turn.data
  const fork = useDocOf(() => props.conversation, VoiceForkDoc)
  const local = () => dock.local()[props.turn.key]
  const audio = () => (data().audio === 'pending' ? local()?.audio : data().audio)
  const said = () =>
    saidIn(data(), audio(), props.submitted ?? !!props.record, fork()?.transcripts ?? undefined)
  const failed = () => {
    const recording = audio()
    return local()?.failed ?? (recording ? fork()?.failed?.[recording] : undefined)
  }
  const [element, setElement] = createSignal<HTMLElement>()
  useSpokenReply(
    () => props.turn.key,
    () => element()?.closest(row) ?? undefined,
  )
  return (
    <Message
      class="group/message mt-3 first:mt-0"
      data-voice-turn={props.turn.key}
      from="user"
      ref={setElement}
    >
      <MessageContent>
        <Show when={data().audio || data().answered}>
          <div class="flex min-w-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <Show when={data().answered}>
              <span class="inline-flex shrink-0 items-center gap-1 text-brand">
                <MessageCircleReply class="size-3" /> sent as your answer
              </span>
            </Show>
            <Show when={data().audio}>
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
              <Show when={said() !== undefined && !failed()}>
                <span class="truncate text-muted-foreground/60">
                  {data().route === 'audio' ? 'the model hears your voice' : 'the model reads this'}
                </span>
              </Show>
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
                      no words heard in the transcript
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

export function StoredTurn(props: { entry: EntryRecord & { data: VoiceTurn } }) {
  const turn = createMemo(() => ({
    key: props.entry.data.key,
    data: props.entry.data,
    images: imagesOf(props.entry),
  }))
  return (
    <VoiceTurnView conversation={props.entry.conversationId} record={props.entry} turn={turn()} />
  )
}

export function PendingTurns() {
  const id = useConversationId()
  const session = useDocOf(() => ROOT, VoiceSessionDoc)
  const conversation = useConversation()
  const pending = createMemo(() => {
    const here = id()
    if (here === undefined || here !== session()?.id) return []
    const state = conversation()
    const candidates = [
      ...Object.entries(dock.local()).flatMap(([key, each]) =>
        each.optimistic && (each.conversation === undefined || each.conversation === here)
          ? [{ key, data: each.optimistic, images: each.images ?? [], submitted: false }]
          : [],
      ),
      ...state.inbox.flatMap((item) =>
        item.mode !== 'write' && item.entry?.kind === VoiceTurnEntry.kind
          ? [
              {
                key: (item.entry.data as VoiceTurn).key,
                data: item.entry.data as VoiceTurn,
                images: imagesIn(item.content),
                submitted: true,
              },
            ]
          : [],
      ),
    ]
    if (!candidates.length) return []
    const shown = new Set(
      state.entries.flatMap((entry) => (VoiceTurnEntry.is(entry) ? [entry.data.key] : [])),
    )
    return candidates.filter((turn) => !shown.has(turn.key) && !!shown.add(turn.key))
  })
  return (
    <For each={pending()} keyed={(turn) => turn.key}>
      {(turn) => (
        <div class="empty-row" data-voice-pending={turn().key}>
          <VoiceTurnView conversation={id()} submitted={turn().submitted} turn={turn()} />
        </div>
      )}
    </For>
  )
}

function actionLine(name: string, args: Record<string, unknown>) {
  if (name === 'ui') {
    if (args.op === 'act' && !Array.isArray(args.steps)) return ''
    if (args.op === 'act')
      return (args.steps as { ref: string; action: string; args?: unknown[] }[])
        .map(
          (step) =>
            `${step.action} ${step.ref}${step.args?.length ? ` ${JSON.stringify(step.args)}` : ''}`,
        )
        .join(' → ')
    if (args.op === 'query') return `find ${JSON.stringify(args.text ?? args.within ?? '')}`
    return 'look at the page'
  }
  if (name === 'voice_handoff')
    return `hand off: ${typeof args.title === 'string' ? args.title : ''}`
  if (name === 'codemode') return 'run a script'
  const first = Object.values(args).find((value) => typeof value === 'string')
  return first ? first.split('\n')[0].slice(0, 80) : ''
}

export function Voicing(props: { fork: ConversationId }) {
  const fork = useDocOf(() => props.fork, VoiceForkDoc)
  createEffect(
    () => {
      const doc = fork()
      return doc
        ? ({
            ...doc,
            transcripts: { ...doc.transcripts },
            failed: { ...doc.failed },
            draft: (doc.draft ?? []).map((clip) => ({ ...clip })),
          } as VoiceFork)
        : doc
    },
    (doc) => settleTranscripts(doc, props.fork),
  )
  const turns = useTurns()
  const conversation = useConversation()
  createEffect(
    () => {
      const busy = conversation().busy
      const slots = conversation().live.tools ?? []
      const turn = turns().turns.findLast((each) => !each.optimistic)
      const calls = [...(turn?.replies ?? []), ...(turn?.live ? [turn.live] : [])].flatMap(
        (message) =>
          message.content.flatMap((part) =>
            part.type === 'toolCall'
              ? [{ id: part.id, name: part.name, args: part.arguments }]
              : [],
          ),
      )
      const running = slots.find((slot) => slot.status !== 'done')
      const shown = running ? calls.find((call) => call.id === running.callId) : calls.at(-1)
      const results = new Set(
        conversation().entries.flatMap((entry) =>
          (entry.model ?? []).flatMap((message) =>
            message.role === 'toolResult' ? [message.toolCallId] : [],
          ),
        ),
      )
      return {
        done: calls.filter((call) => results.has(call.id)).length,
        current:
          busy && shown
            ? `${running ? '' : 'after '}${shown.name} ${actionLine(shown.name, shown.args)}`.trim()
            : undefined,
      }
    },
    (next) => {
      setActivity({ ...next })
    },
  )
  onCleanup(() => setActivity({ done: 0 }))
  useSpeaking(turns)
  return null
}
