import { AudioLinesIcon, PlayIcon, SquareIcon, Volume2Icon, VolumeOffIcon } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import {
  api,
  cn,
  defineWebExtension,
  docRef,
  useConnection,
  useConversations,
  useDocOf,
  useEvents,
  useExtensionUiState,
  useNow,
} from '@/sdk'
import type { LiveState } from '@/sdk'
import { MessagesDoc, emptyMessages } from '../messages/ui.tsx'
import { OverviewDoc } from '../conversations/ui.tsx'
import { StandingDoc } from '../subagents/ui.tsx'
import { Committed } from '../coding-tools/ui.tsx'
import { CheckRan, SubmissionLanded } from '../workspaces/ui.tsx'
import { Branched } from '../lineage/ui.tsx'
import { listener, sounds } from './cues.ts'
import type { Cue, Sound } from './cues.ts'
import { tracker, variants } from './agents.ts'
import type { Variant } from './agents.ts'
import * as conductor from './conductor.ts'
import * as tones from './tones.ts'
import { linesOf, spoken } from './narration.ts'
import { SayAction } from './refs.ts'

const playedKey = 'ultimate.sounds.played'

function useSettings() {
  const [muted, setMuted] = useExtensionUiState('muted', false)
  const [off, setOff] = useExtensionUiState<Sound[]>('off', [])
  const [volume, setVolume] = useExtensionUiState('volume', 0.8)
  // The sound of agents: off, or the variant that plays.
  const [stored, setAgents] = useExtensionUiState<string>('agents', 'off')
  // Ambient became Chiptune; a variant from another build plays as off.
  const id = stored === 'ambient' ? 'chiptune' : stored
  const agents: Variant | 'off' = variants.some((variant) => variant.id === id)
    ? (id as Variant)
    : 'off'
  // The narrator speaks a line after each cue; new branches only with `branches` on.
  const [narrator, setNarrator] = useExtensionUiState('narrator', false)
  const [branches, setBranches] = useExtensionUiState('narrateBranches', false)
  return {
    muted,
    setMuted,
    off,
    setOff,
    volume,
    setVolume,
    agents,
    setAgents,
    narrator,
    setNarrator,
    branches,
    setBranches,
  }
}

/**
 * Sounds `cue` in one tab only: every open tab sees the same event, and the first that may play claims it under a
 * lock, in this origin's storage. A tab nobody has clicked in yet may not play, so it leaves the event to another.
 */
async function claim(cues: readonly Cue[]) {
  if (!navigator.userActivation.hasBeenActive) return []
  return navigator.locks.request(playedKey, () => {
    const played: string[] = JSON.parse(localStorage.getItem(playedKey) ?? '[]')
    const fresh = cues.filter((cue) => !played.includes(cue.key))
    localStorage.setItem(
      playedKey,
      JSON.stringify([...played, ...fresh.map((cue) => cue.key)].slice(-100)),
    )
    return fresh
  })
}

/** How long the narrator gathers cues before speaking, so what arrives together becomes one line. */
const gatherMs = 1500

/**
 * Speaks lines one at a time, each after its notification sound: cues that arrive while it gathers or speaks join the
 * next line. A line OpenAI's voice cannot say is said by the browser's.
 */
function speaker() {
  let waiting: Cue[] = []
  let busy = false
  const run = async () => {
    busy = true
    try {
      while (waiting.length) {
        await new Promise((resolve) => setTimeout(resolve, gatherMs))
        const cues = waiting
        waiting = []
        for (const line of linesOf(cues)) {
          if (!line.text) {
            await tones.play(line.sound)
            continue
          }
          const { audio } = await api
            .action(SayAction, { text: line.text })
            .catch((error: unknown) => {
              console.warn('Narrator voice failed', error)
              return { audio: null }
            })
          const pcm = audio
            ? Uint8Array.from(atob(audio), (c) => c.charCodeAt(0)).buffer
            : undefined
          await tones.say(line.sound, line.text, pcm)
        }
      }
    } finally {
      busy = false
    }
  }
  return (cues: readonly Cue[]) => {
    waiting.push(...cues)
    if (!busy) run().catch((error: unknown) => console.warn('Narrator failed', error))
  }
}

/**
 * Watches @ultimate and sounds what it newly tells the user: a question, a finished answer,
 * a failed run, and each landing. Whatever it shows when this tab opens has been heard already.
 */
function Player() {
  const overview = useDocOf(1, OverviewDoc)
  const log = useDocOf(1, MessagesDoc)
  const agent = useDocOf(1, StandingDoc)?.ultimate
  const landings = useEvents({ events: [SubmissionLanded], limit: 20 })
  const branched = useEvents({ events: [Branched], limit: 20 })
  const conversations = useConversations()
  const { muted, off, volume, agents, narrator: narrating, branches } = useSettings()
  const [hear] = useState(listener)
  const [narrate] = useState(speaker)
  // The narrator speaks while the tab is hidden too; only a reconnect or the tab opening counts as catching up.
  const catchingUp = useCatchingUp(narrating)
  useEffect(() => tones.setVolume(muted ? 0 : volume), [muted, volume])
  useEffect(() => {
    // oxlint-disable-next-line typescript/no-floating-promises -- conduct catches nothing worth reporting beyond a warning.
    conductor
      .conduct(muted || agents === 'off' ? undefined : agents)
      .catch((error: unknown) => console.warn('Sound of agents failed', error))
  }, [muted, agents])
  useEffect(() => {
    // Until the event feed has arrived, its whole history would come as news.
    if (!overview || agent === undefined || !landings || !branched) return
    const due = hear(
      {
        agent,
        row: overview.conversations[agent],
        messages: (log ?? emptyMessages).messages,
        landings: landings.map(({ id, data }) => ({ id, title: spoken(data.title) })),
        branches: branched.map(({ id, data }) => ({ id, title: spoken(data.title) })),
        title: (id) => spoken(conversations.find((row) => row.id === id)?.title),
      },
      catchingUp(),
    ).filter(
      (cue) =>
        !muted && !off.includes(cue.sound) && (cue.sound !== 'started' || (narrating && branches)),
    )
    if (!due.length) return
    claim(due)
      .then(async (mine) => {
        if (narrating) return narrate(mine)
        for (const cue of mine) await tones.play(cue.sound)
      })
      .catch((error: unknown) => console.warn('Sound failed', error))
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `catchingUp` reads the time; titles are read when news comes.
  }, [hear, overview, log, agent, landings, branched, muted, off, narrating, branches])
  // The Landed notification plays each landing once; the band lands with it only when that notification is off.
  return agents !== 'off' && !muted ? <Listener landings={off.includes('landed')} /> : null
}

const watched = [SubmissionLanded, Committed, CheckRan] as const

/** How long after the tab opens, shows again or reconnects its stream what arrives is taken as heard. */
const settleMs = 3000

/**
 * Whether what arrives now was heard already: while the tab is hidden or its stream is down, and for a moment after it
 * opens, shows again or reconnects, while the documents and the event feed catch up with what happened meanwhile.
 */
function useCatchingUp(hidden = false) {
  const connection = useConnection()
  const opened = useRef(Date.now())
  const shown = useRef(Date.now())
  useEffect(() => {
    const update = () => {
      if (!document.hidden) shown.current = Date.now()
    }
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  // With `hidden`, a hidden tab still hears what happens now: only the tab opening or the stream reconnecting catch up.
  return () =>
    connection.status !== 'open' ||
    (!hidden && document.hidden) ||
    Date.now() < Math.max(hidden ? opened.current : shown.current, connection.since) + settleMs
}

/** While the sound of agents plays: follows every conversation, tool call and landing, and hands them to the band. */
function Listener({ landings }: { landings: boolean }) {
  const conversations = useConversations()
  const overview = useDocOf(1, OverviewDoc)
  const standing = useDocOf(1, StandingDoc)
  const events = useEvents({ events: watched, limit: 20 })
  const [follow] = useState(tracker)
  const catchingUp = useCatchingUp()
  // Each busy conversation's live round, reported by a `RoundOf`: its tool calls by name. A fast call passes through
  // `pi.live` but often not through the coalesced task graph.
  const [rounds, setRounds] = useState<Record<number, Round>>({})
  const busy = conversations.filter((conversation) => conversation.busy).map(({ id }) => id)
  useEffect(() => {
    // Until every source has arrived, a later one would bring its whole history as news.
    if (!overview || !standing || !events) return
    const live = busy.map((id) => rounds[id]).filter((round) => round !== undefined)
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
      if (landings || happening.kind !== 'landed') conductor.hit(happening)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `busy` follows `conversations`; `catchingUp` reads the time.
  }, [follow, conversations, standing, rounds, overview, events, landings])
  return busy.map((id) => <RoundOf id={id} key={id} report={setRounds} />)
}

/** `pi.live` alone: a conversation's whole view would stream its transcript to every tab that plays. */
const LiveDoc = docRef<LiveState>('pi.live')

type Round = { tools: [string, { name: string; conversationId: number }][] }

/** Reports conversation `id`'s current round from its `pi.live`. */
function RoundOf({
  id,
  report,
}: {
  id: number
  report: (update: (previous: Record<number, Round>) => Record<number, Round>) => void
}) {
  const live = useDocOf(id, LiveDoc)
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

const preview = (sound: Sound) =>
  tones.play(sound).catch((error: unknown) => console.warn('Sound failed', error))

const row = 'flex h-8 items-center justify-between gap-2 px-2 text-[12px]'
const section = 'border-t border-border/70 pt-1'

/** The status-bar entry: sounds on or off, volume, the sound of agents, and each notification cue. */
function Control() {
  const {
    muted,
    setMuted,
    off,
    setOff,
    volume,
    setVolume,
    agents,
    setAgents,
    narrator: narrating,
    setNarrator,
    branches,
    setBranches,
  } = useSettings()
  const stage = useSyncExternalStore(conductor.subscribe, conductor.current)
  const now = useNow(1000, stage.demoUntil !== undefined)
  const playing = agents !== 'off' && !muted
  const left =
    stage.demoUntil === undefined
      ? undefined
      : Math.max(0, Math.ceil((stage.demoUntil - now) / 1000))
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label="Sounds"
          className={cn(
            '-mx-1 flex items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground',
            muted && 'text-muted-foreground/60',
            playing && 'text-brand',
          )}
          type="button"
        >
          {muted ? (
            <VolumeOffIcon className="size-3" />
          ) : playing ? (
            <AudioLinesIcon className="size-3 animate-pulse" />
          ) : (
            <Volume2Icon className="size-3" />
          )}
          sounds
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1 font-mono" side="top">
        <label className={cn(row, 'cursor-pointer')}>
          Sounds
          <Switch checked={!muted} onCheckedChange={(on) => setMuted(!on)} />
        </label>
        <label className={cn(row, muted && 'opacity-50')}>
          <span className="text-muted-foreground">Volume</span>
          <input
            aria-label="Volume"
            className="h-1 w-32 cursor-pointer accent-brand"
            disabled={muted}
            max={1}
            min={0}
            onChange={(event) => setVolume(Number(event.target.value))}
            step={0.05}
            type="range"
            value={volume}
          />
        </label>
        <div className={cn(section, muted && 'opacity-50')}>
          <label className={cn(row, 'cursor-pointer')}>
            Narrator
            <Switch checked={narrating} disabled={muted} onCheckedChange={setNarrator} />
          </label>
          {narrating && (
            <>
              <label className="flex h-7 cursor-pointer items-center gap-2 px-2 text-[12px]">
                <Checkbox
                  checked={branches}
                  disabled={muted}
                  onCheckedChange={(on) => setBranches(on === true)}
                />
                Announce new branches
              </label>
              <div className="px-2 pt-0.5 pb-1 text-[11px] leading-4 text-muted-foreground">
                Speaks questions, failures and landings after their sound, also while the tab is
                hidden. Branch titles go to OpenAI to be spoken.
              </div>
            </>
          )}
        </div>
        <div className={cn(section, muted && 'opacity-50')}>
          <label className={cn(row, 'cursor-pointer')}>
            Sound of agents
            <Switch
              checked={agents !== 'off'}
              disabled={muted}
              onCheckedChange={(on) => setAgents(on ? 'chiptune' : 'off')}
            />
          </label>
          {agents !== 'off' && (
            <>
              <div
                aria-label="Variant"
                className="mx-2 mb-1 grid grid-cols-3 rounded-md border border-border/70 p-px"
                role="radiogroup"
              >
                {variants.map((variant) => (
                  <button
                    aria-checked={agents === variant.id}
                    className={cn(
                      'h-6 cursor-pointer rounded-[5px] text-[11px] text-muted-foreground transition-colors hover:text-foreground',
                      agents === variant.id && 'bg-accent text-foreground',
                    )}
                    disabled={muted}
                    key={variant.id}
                    onClick={() => setAgents(variant.id)}
                    role="radio"
                    title={variant.detail}
                    type="button"
                  >
                    {variant.label}
                  </button>
                ))}
              </div>
              <div className="px-2 pb-1 text-[11px] leading-4 text-muted-foreground">
                {variants.find((variant) => variant.id === agents)?.detail}
              </div>
              <button
                className={cn(
                  row,
                  'w-full cursor-pointer rounded-sm whitespace-nowrap hover:bg-accent',
                  left !== undefined && 'text-brand',
                )}
                disabled={muted}
                onClick={() => (left === undefined ? conductor.startDemo() : conductor.stopDemo())}
                type="button"
              >
                <span className="flex items-center gap-2">
                  {left === undefined ? (
                    <PlayIcon className="size-3" />
                  ) : (
                    <SquareIcon className="size-3" />
                  )}
                  {left === undefined ? 'Start demo' : 'Stop demo'}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {left === undefined ? '40s' : `${left}s`}
                </span>
              </button>
              {stage.blocked && (
                <div className="px-2 pb-1 text-[11px] text-warning">
                  Click anywhere to start audio
                </div>
              )}
            </>
          )}
        </div>
        <div className={section}>
          {sounds.map(({ sound, label }) => (
            <div
              className={cn('flex h-7 items-center gap-2 px-2 text-[12px]', muted && 'opacity-50')}
              key={sound}
            >
              <label className="flex flex-1 cursor-pointer items-center gap-2">
                <Checkbox
                  checked={!off.includes(sound)}
                  disabled={muted}
                  onCheckedChange={(on) => {
                    setOff((previous) =>
                      on ? previous.filter((other) => other !== sound) : [...previous, sound],
                    )
                    // oxlint-disable-next-line typescript/no-floating-promises -- preview catches and logs playback failures.
                    if (on) void preview(sound)
                  }}
                />
                {label}
              </label>
              <button
                aria-label={`Play ${label}`}
                className="grid size-5 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => void preview(sound)}
                type="button"
              >
                <PlayIcon className="size-3" />
              </button>
            </div>
          ))}
          <div className="px-2 pt-0.5 pb-1 text-[11px] text-muted-foreground">
            Landings from any branch; the rest from @ultimate only
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default defineWebExtension({
  messages: { ja: { 'Play the sound of agents demo': 'エージェントの音のデモを再生' } },
  slots: { overlay: [Player], 'statusline.right': [{ component: Control, order: -1 }] },
  commands: [
    {
      id: 'sounds.demo',
      title: 'Play the sound of agents demo',
      run: () => conductor.startDemo(),
    },
  ],
})
