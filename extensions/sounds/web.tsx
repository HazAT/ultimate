import type { ConversationId } from '@earendil-works/pi-durable'
import { ROOT } from '@/sdk'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  defineWebExtension,
  docRef,
  island,
  useConnection,
  useConversations,
  useDocOf,
  useEvents,
  switched,
  useExtensionUiState,
} from '@/sdk'
import type { LiveState } from '@/sdk'
import { MessagesDoc, emptyMessages } from '../messages/ui.tsx'
import { OverviewDoc } from '../conversations/ui.tsx'
import { StandingDoc } from '../subagents/ui.tsx'
import { Committed } from '../coding-tools/ui.tsx'
import { CheckRan, SubmissionLanded } from '../workspaces/ui.tsx'
import { Branched } from '../lineage/ui.tsx'
import { listener } from './cues.ts'
import type { Cue, Sound } from './cues.ts'
import { tracker } from './agents.tsx'
import { Control } from './chip.solid.tsx'
import { variantOf } from './variants.ts'
import * as conductor from './conductor.ts'
import * as tones from './tones.ts'
import { spoken } from './narration.ts'
import type { Line } from './narration.ts'
import { speaker } from './speaker.ts'
import { SayAction } from './refs.ts'
import { questionsSpoken } from './ui.tsx'

const eventClaimKey = 'ultimate.sounds.played'

function useSettings() {
  const [muted] = useExtensionUiState('muted', false)
  const [off] = useExtensionUiState<Sound[]>('off', [])
  const [volume] = useExtensionUiState('volume', 0.8)
  const [stored] = useExtensionUiState('agents', 'off')
  const [narrator] = useExtensionUiState('narrator', false)
  const [branches] = useExtensionUiState('narrateBranches', false)
  return {
    muted,
    off,
    volume,
    agents: variantOf(stored)?.id ?? ('off' as const),
    narrator,
    branches,
  }
}

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

function Player() {
  const overview = useDocOf(ROOT, OverviewDoc)
  const log = useDocOf(ROOT, MessagesDoc)
  const agent = useDocOf(ROOT, StandingDoc)?.ultimate
  const landings = useEvents({ events: [SubmissionLanded], limit: 20 })
  const branched = useEvents({ events: [Branched], limit: 20 })
  const conversations = useConversations()
  const { muted, off, volume, agents, narrator: narrating, branches } = useSettings()
  const [hear] = useState(listener)
  const [narrate] = useState(resumeSwitchedNarrator)

  const catchingUp = useCatchingUp(narrating)
  const titles = useRef(conversations)
  titles.current = conversations
  useEffect(() => tones.setVolume(muted ? 0 : volume), [muted, volume])
  useEffect(() => {
    conductor
      .conduct(muted || agents === 'off' ? undefined : agents)
      .catch((error: unknown) => console.warn('Sound of agents failed', error))
  }, [muted, agents])
  useEffect(() => {
    const missingCueHistory = !overview || agent === undefined || !landings || !branched
    if (missingCueHistory) return
    const due = hear(
      {
        agent,
        row: overview.conversations[agent],
        messages: (log ?? emptyMessages).messages,
        landings: landings.map(({ id, data }) => ({ id, title: spoken(data.title) })),
        branches: branched.map(({ id, data }) => ({ id, title: spoken(data.title) })),
        title: (id) => spoken(titles.current.find((row) => row.id === id)?.title),
      },
      catchingUp(),
    ).filter(
      (cue) =>
        !muted && !off.includes(cue.sound) && (cue.sound !== 'started' || (narrating && branches)),
    )
    if (!due.length) return
    claimPlayableCues(due)
      .then(async (mine) => {
        if (narrating) return narrate(mine)
        for (const cue of mine) await tones.play(cue.sound)
      })
      .catch((error: unknown) => console.warn('Sound failed', error))
  }, [
    hear,
    overview,
    log,
    agent,
    landings,
    branched,
    muted,
    off,
    narrating,
    branches,
    catchingUp,
    narrate,
  ])

  return agents !== 'off' && !muted ? <Listener bandOwnsLanding={off.includes('landed')} /> : null
}

const watched = [SubmissionLanded, Committed, CheckRan] as const

const reconnectCatchUpMs = 3000

function useCatchingUp(narrateWhileHidden = false) {
  const connection = useConnection()
  const latest = useRef({ connection, narrateWhileHidden })
  latest.current = { connection, narrateWhileHidden }
  const opened = useRef(Date.now())
  const shown = useRef(Date.now())
  useEffect(() => {
    const update = () => {
      if (!document.hidden) shown.current = Date.now()
    }
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  return useCallback(() => {
    const current = latest.current
    return (
      current.connection.status !== 'open' ||
      (!current.narrateWhileHidden && document.hidden) ||
      Date.now() <
        Math.max(
          current.narrateWhileHidden ? opened.current : shown.current,
          current.connection.since,
        ) +
          reconnectCatchUpMs
    )
  }, [])
}

function Listener({ bandOwnsLanding }: { bandOwnsLanding: boolean }) {
  const conversations = useConversations()
  const overview = useDocOf(ROOT, OverviewDoc)
  const standing = useDocOf(ROOT, StandingDoc)
  const events = useEvents({ events: watched, limit: 20 })
  const [follow] = useState(tracker)
  const catchingUp = useCatchingUp()

  const [rounds, setRounds] = useState<Record<number, Round>>({})
  const busy = conversations.filter((conversation) => conversation.busy).map(({ id }) => id)
  useEffect(() => {
    const missingBandHistory = !overview || !standing || !events
    if (missingBandHistory) return
    const live = conversations
      .filter((conversation) => conversation.busy)
      .map(({ id }) => rounds[id])
      .filter((round) => round !== undefined)
    const happenings = follow(
      {
        conversations,
        standing: new Set(Object.values(standing)),
        tools: Object.fromEntries(live.flatMap((round) => round.tools)),
        runs: overview.conversations,
        events,
      },
      catchingUp(),
    )
    for (const happening of happenings)
      if (bandOwnsLanding || happening.kind !== 'landed') conductor.hit(happening)
  }, [follow, conversations, standing, rounds, overview, events, bandOwnsLanding, catchingUp])
  return busy.map((id) => <RoundOf id={id} key={id} report={setRounds} />)
}

const LiveToolsDoc = docRef<LiveState>('pi.live')

type Round = { tools: [string, { name: string; conversationId: ConversationId }][] }

function RoundOf({
  id,
  report,
}: {
  id: ConversationId
  report: (update: (previous: Record<number, Round>) => Record<number, Round>) => void
}) {
  const live = useDocOf(id, LiveToolsDoc)
  useEffect(() => {
    const round: Round = {
      tools: [...(live?.tools ?? []), ...(live?.nestedTools ?? [])].map((slot) => [
        `${id}:${slot.callId}`,
        { name: slot.name, conversationId: id },
      ]),
    }
    report((previous) => ({ ...previous, [id]: round }))
  }, [id, live, report])
  return null
}

export default defineWebExtension({
  slots: { overlay: [Player], 'statusline.right': [{ component: island(Control), order: -1 }] },
  commands: [
    {
      id: 'sounds.demo',
      title: 'Play the sound of agents demo',
      run: () => conductor.startDemo(),
    },
  ],
})
