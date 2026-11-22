import type { ConversationId } from '@earendil-works/pi-durable'
import { createEffect, createMemo, mapArray, Show } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { LiveState } from '@/sdk/solid'
import {
  ROOT,
  api,
  docRef,
  switched,
  useConnection,
  useConversations,
  useDocOf,
  useEvents,
  useExtensionUiState,
  usePageVisible,
} from '@/sdk/solid'
import { Committed } from '../coding-tools/refs.ts'
import { OverviewDoc } from '../conversations/refs.ts'
import type { OverviewRow } from '../conversations/types.ts'
import { Branched } from '../lineage/refs.ts'
import { MessagesDoc } from '../messages/refs.ts'
import { StandingDoc } from '../subagents/refs.ts'
import { CheckRan, SubmissionLanded } from '../workspaces/refs.ts'
import { tracker } from './agents.ts'
import * as conductor from './conductor.ts'
import { listener } from './cues.ts'
import type { Cue, Sound } from './cues.ts'
import { spoken } from './narration.ts'
import type { Line } from './narration.ts'
import { SayAction } from './refs.ts'
import { speaker } from './speaker.ts'
import * as tones from './tones.ts'
import { variantOf } from './variants.ts'
import { questionsSpoken } from './voiced.ts'

const eventClaimKey = 'ultimate.sounds.played'
const reconnectCatchUpMs = 3000
const LiveToolsDoc = docRef<LiveState>('pi.live')

async function claimPlayableCues(cues: readonly Cue[]) {
  const tabCannotPlayWithoutGesture = !navigator.userActivation.hasBeenActive
  if (tabCannotPlayWithoutGesture) return []
  return navigator.locks.request(eventClaimKey, () => {
    const played: string[] = JSON.parse(localStorage.getItem(eventClaimKey) ?? '[]')
    const fresh = cues.filter((cue) => !played.includes(cue.key))
    localStorage.setItem(
      eventClaimKey,
      JSON.stringify([...played, ...fresh.map((cue) => cue.key)].slice(-100)),
    )
    return fresh
  })
}

async function sayLine(line: Line) {
  if (!line.text || (line.sound === 'input' && questionsSpoken())) return tones.play(line.sound)
  const { audio } = await api.action(SayAction, { text: line.text }).catch((error: unknown) => {
    console.warn('Narrator voice failed', error)
    return { audio: null }
  })
  const pcm = audio ? Uint8Array.from(atob(audio), (c) => c.charCodeAt(0)).buffer : undefined
  await tones.say(line.sound, line.text, pcm)
}

function resumeSwitchedNarrator() {
  const narrate = speaker(sayLine, sessionStorage)
  narrate.resume(Boolean(switched))
  return narrate.add
}

function rowOf(row: OverviewRow | undefined): OverviewRow | undefined {
  if (!row) return undefined
  const { runState, inputId, answerId, internalInput } = row
  return { runState, inputId, answerId, internalInput }
}

function catchingUpFor(narrateWhileHidden: Accessor<boolean>) {
  const connection = useConnection()
  const visible = usePageVisible()
  const opened = Date.now()
  const shown = createMemo(() => (visible() ? Date.now() : 0))
  return () => {
    const whileHidden = narrateWhileHidden()
    const { status, since } = connection()
    return (
      status !== 'open' ||
      (!whileHidden && !visible()) ||
      Date.now() < Math.max(whileHidden ? opened : shown(), since) + reconnectCatchUpMs
    )
  }
}

export function Player() {
  const [muted] = useExtensionUiState('muted', false)
  const [off] = useExtensionUiState<Sound[]>('off', [])
  const [volume] = useExtensionUiState('volume', 0.8)
  const [stored] = useExtensionUiState('agents', 'off')
  const [narrating] = useExtensionUiState('narrator', false)
  const [branches] = useExtensionUiState('narrateBranches', false)
  const band = createMemo(() => (muted() ? undefined : variantOf(stored())?.id))

  const overview = useDocOf(() => ROOT, OverviewDoc)
  const log = useDocOf(() => ROOT, MessagesDoc)
  const standing = useDocOf(() => ROOT, StandingDoc)
  const landings = useEvents({ events: [SubmissionLanded], limit: 20 })
  const branched = useEvents({ events: [Branched], limit: 20 })
  const conversations = useConversations()
  const hear = listener()
  const narrate = resumeSwitchedNarrator()
  const catchingUp = catchingUpFor(narrating)

  createEffect(() => (muted() ? 0 : volume()), tones.setVolume)
  createEffect(band, (variant) => {
    conductor
      .conduct(variant)
      .catch((error: unknown) => console.warn('Sound of agents failed', error))
  })
  createEffect(
    () => {
      const agent = standing()?.ultimate
      const rows = overview()
      const landed = landings()
      const started = branched()
      if (!rows || agent === undefined || !landed || !started) return undefined
      const titles = new Map<number, string | undefined>(
        conversations().map((row) => [row.id, row.title]),
      )
      return {
        watched: {
          agent,
          row: rowOf(rows.conversations[agent]),
          messages: (log()?.messages ?? []).map(({ id, from, to, reply }) => ({
            id,
            from,
            to,
            reply,
          })),
          landings: landed.map(({ id, data }) => ({ id, title: spoken(data.title) })),
          branches: started.map(({ id, data }) => ({ id, title: spoken(data.title) })),
          title: (id: number) => spoken(titles.get(id)),
        },
        catchingUp: catchingUp(),
        muted: muted(),
        off: off(),
        narrating: narrating(),
        branches: branches(),
      }
    },
    (heard) => {
      if (!heard) return
      const due = hear(heard.watched, heard.catchingUp).filter(
        (cue) =>
          !heard.muted &&
          !heard.off.includes(cue.sound) &&
          (cue.sound !== 'started' || (heard.narrating && heard.branches)),
      )
      if (!due.length) return
      claimPlayableCues(due)
        .then(async (mine) => {
          if (heard.narrating) return narrate(mine)
          for (const cue of mine) await tones.play(cue.sound)
        })
        .catch((error: unknown) => console.warn('Sound failed', error))
    },
  )

  return (
    <Show when={band()}>
      <Band ownsLanding={off().includes('landed')} />
    </Show>
  )
}

function Band(props: { ownsLanding: boolean }) {
  const conversations = useConversations()
  const overview = useDocOf(() => ROOT, OverviewDoc)
  const standing = useDocOf(() => ROOT, StandingDoc)
  const events = useEvents({ events: [SubmissionLanded, Committed, CheckRan], limit: 20 })
  const follow = tracker()
  const catchingUp = catchingUpFor(() => false)
  const busy = createMemo(() =>
    conversations()
      .filter((conversation) => conversation.busy)
      .map(({ id }) => id),
  )
  const rounds = mapArray(busy, (id: ConversationId) => {
    const live = useDocOf(() => id, LiveToolsDoc)
    return () =>
      [...(live()?.tools ?? []), ...(live()?.nestedTools ?? [])].map(
        (slot) => [`${id}:${slot.callId}`, { name: slot.name, conversationId: id }] as const,
      )
  })
  createEffect(
    () => {
      const runs = overview()?.conversations
      const agents = standing()
      const happened = events()
      if (!runs || !agents || !happened) return undefined
      return {
        conversations: conversations(),
        standing: new Set(Object.values(agents)),
        tools: Object.fromEntries(rounds().flatMap((round) => round())),
        runs: Object.fromEntries(
          Object.entries(runs).map(([id, run]) => [
            id,
            { runState: run.runState, inputId: run.inputId },
          ]),
        ),
        events: happened.flatMap((event) => {
          const kind = Committed.is(event)
            ? 'commit'
            : SubmissionLanded.is(event)
              ? 'landed'
              : CheckRan.is(event) && event.data.result === 'failed'
                ? 'failed'
                : undefined
          return kind ? [{ id: event.id, kind } as const] : []
        }),
        ownsLanding: props.ownsLanding,
        catchingUp: catchingUp(),
      }
    },
    (heard) => {
      if (!heard) return
      for (const happening of follow(heard, heard.catchingUp))
        if (heard.ownsLanding || happening.kind !== 'landed') conductor.hit(happening)
    },
  )
  return null
}
