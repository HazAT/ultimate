import { HourglassIcon, PauseIcon, PlayIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  api,
  attention,
  Card,
  cn,
  defineWebExtension,
  formatDuration,
  errorMessage,
  getState,
  ParkedRuns,
  provide,
  useAction,
  useDocOf,
  useNow,
  useTasks,
  useUltimate,
} from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { store } from '@/sdk/client'
import { ConversationRef } from '../conversations/ui.tsx'
import { lasted } from './lasted.ts'
import { parkedConversations } from './parked.ts'
import { AutoPlayAction, PauseAction, PauseDoc, PlayAction, StateAction } from './refs.ts'
import type { AutoPlayed, HeldNote, PauseNote, PauseState, RateLimit } from './refs.ts'

const statusButton =
  '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent'

const tasks = (count: number) => `${count} ${count === 1 ? 'task' : 'tasks'}`

/** A time today or tomorrow, as the status line says it: `14:07`. */
const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** What the provider said: the upstream message a relay wraps (Claude Code's), a JSON body's message, or the error. */
const said = (error: string) =>
  /upstream said: (.+)\)$/s.exec(error)?.[1] ??
  /"message"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(error)?.[1]?.replaceAll('\\"', '"') ??
  error

/** Whether the host is paused, live from the root's pause document. */
const usePaused = () => useDocOf(1, PauseDoc)?.paused === true

/** The pause and what still runs, refreshed when the doc changes and, while paused, with the task graph. */
function usePauseState() {
  const doc = useDocOf(1, PauseDoc)
  const live = useTasks()
  const graph = doc?.paused ? live : undefined
  const { data } = useAction(
    StateAction,
    null,
    // A failed poll keeps the last state; the next change asks again.
    { onError: () => {}, on: [doc, graph] },
  )
  return data
}

function Running({ state }: { state: PauseState }) {
  const now = useNow(1000, state.running.length > 0)
  const { switchConversation } = useUltimate()
  return (
    <ul className="space-y-1">
      {state.running.map((task) => (
        <li className="flex min-w-0 items-center gap-2" key={task.task}>
          <button
            className="min-w-0 flex-1 cursor-pointer text-left hover:underline"
            onClick={() => switchConversation(task.conversationId)}
            type="button"
          >
            <ConversationRef id={task.conversationId} title={task.title} />
          </button>
          <span className="shrink-0 text-muted-foreground">{task.what}</span>
          {task.startedAt !== undefined && (
            <span className="w-14 shrink-0 text-right text-muted-foreground/70 tabular-nums">
              {formatDuration(Math.max(0, now - task.startedAt))}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

function Popup({
  state,
  busy,
  error,
  toggle,
}: {
  state: PauseState
  busy: boolean
  error?: string
  toggle: () => void
}) {
  const now = useNow(1000, state.paused)
  const pausing = state.paused && state.running.length > 0
  const { limit, held } = state
  return (
    <>
      <div className="border-b border-border/70 px-3 py-2 section-label">
        {limit ? 'Rate limited' : held ? `Held by ${held.source}` : 'Pause'}
      </div>
      <div className="space-y-2 px-3 py-2 text-[11.5px] leading-[1.55]">
        {limit && (
          <div className="space-y-1" data-pause-limit-detail>
            <div>
              <span className="text-warning">{limit.provider}</span> rate limited{' '}
              <span className="text-muted-foreground">{limit.model}</span>
              {state.since !== undefined && (
                <span className="text-muted-foreground"> · {lasted(now - state.since)} ago</span>
              )}
            </div>
            <div className="break-words text-muted-foreground" title={limit.error}>
              “{said(limit.error)}”
            </div>
            <div className="text-muted-foreground">
              {state.autoPlayAt !== undefined
                ? `No reset time given: plays by itself in ${lasted(Math.max(0, state.autoPlayAt - now))}, or press Play.`
                : 'No reset time given: nothing retries until Play.'}{' '}
              A model you switch meanwhile applies on Play.
            </div>
          </div>
        )}
        {held && !limit && (
          <div className="space-y-1" data-pause-held-detail>
            <div className="break-words text-warning" title={held.reason}>
              “{held.reason}”
            </div>
            <div className="text-muted-foreground">
              <span className="text-foreground">{held.source}</span> paused Ultimate
              {state.since !== undefined && <> · {lasted(now - state.since)} ago</>}:{' '}
              {state.autoPlayAt !== undefined ? (
                <span data-pause-resumes>
                  plays by itself at{' '}
                  <span className="text-foreground">{clock(state.autoPlayAt)}</span> (in{' '}
                  {lasted(Math.max(0, state.autoPlayAt - now))}), or press Play.
                </span>
              ) : (
                'nothing starts until you press Play.'
              )}
            </div>
          </div>
        )}
        {!state.paused ? (
          <div className="text-muted-foreground">
            Pause stops new work: running tasks finish, nothing new starts, messages queue until
            Play. Nothing is killed.
          </div>
        ) : pausing ? (
          <>
            <div>
              <span className="text-warning">Pausing…</span> waiting for{' '}
              {tasks(state.running.length)} to finish; nothing new starts.
            </div>
            <Running state={state} />
          </>
        ) : limit ? (
          <div>
            <span className="text-warning">Paused · safe</span>: held runs continue where they
            stopped on Play.
          </div>
        ) : (
          <div>
            <span className="text-warning">Paused · safe</span>: nothing runs.{' '}
            {state.since !== undefined && (
              <span className="text-muted-foreground">for {lasted(now - state.since)}</span>
            )}
          </div>
        )}
        {error && <div className="break-words text-error">{error}</div>}
        <AutoPlay minutes={state.autoPlay} />
      </div>
      <div className="flex justify-end border-t border-border/70 px-3 py-1.5">
        <Button
          className="h-7 font-sans text-[12px]"
          data-pause-toggle
          disabled={busy}
          onClick={toggle}
          size="sm"
          variant="outline"
        >
          {state.paused ? <PlayIcon className="size-3" /> : <PauseIcon className="size-3" />}
          {state.paused ? 'Play' : 'Pause'}
        </Button>
      </div>
    </>
  )
}

/** The user's setting: after a rate limit, play by itself after N minutes. Off by default; a Pause you press waits. */
function AutoPlay({ minutes }: { minutes?: number }) {
  const [draft, setDraft] = useState(String(minutes ?? 30))
  const [error, setError] = useState<string>()
  const save = (next: number | null) => {
    setError(undefined)
    api
      .action(AutoPlayAction, { minutes: next })
      .catch((failure: unknown) => setError(errorMessage(failure)))
  }
  return (
    <div
      className="space-y-1 border-t border-border/50 pt-2 text-muted-foreground"
      data-pause-autoplay
    >
      <label className="flex items-center gap-2">
        <input
          checked={minutes !== undefined}
          className="accent-brand"
          onChange={(event) => save(event.target.checked ? Number(draft) || 30 : null)}
          type="checkbox"
        />
        <span>Play by itself after</span>
        <input
          className="w-12 rounded-sm border border-border bg-transparent px-1 text-right tabular-nums"
          max={1440}
          min={1}
          onBlur={() => minutes !== undefined && Number(draft) !== minutes && save(Number(draft))}
          onChange={(event) => setDraft(event.target.value)}
          type="number"
          value={draft}
        />
        <span>min</span>
      </label>
      <div className="text-muted-foreground/70">
        Only after a rate limit, once per limit. A Pause you press waits for you.
      </div>
      {error && <div className="break-words text-error">{error}</div>}
    </div>
  )
}

/** The status-line item: a quiet Pause, amber while pausing or paused. */
function Item() {
  const state = usePauseState()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  if (!state) return null
  const toggle = () => {
    setBusy(true)
    setError(undefined)
    api
      .action(state.paused ? PlayAction : PauseAction)
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : String(failure)),
      )
      .finally(() => setBusy(false))
  }
  const pausing = state.paused && state.running.length > 0
  const resumes = state.autoPlayAt !== undefined && !pausing && (
    <span data-pause-until> · until {clock(state.autoPlayAt)}</span>
  )
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            statusButton,
            state.paused ? 'text-warning' : 'text-muted-foreground/70 hover:text-foreground',
          )}
          data-pause={state.paused ? (pausing ? 'pausing' : 'paused') : 'running'}
          title="Pause or continue all work"
          type="button"
        >
          {pausing ? (
            <>
              <HourglassIcon className="size-3" />
              Pausing…<span className="max-md:hidden"> {tasks(state.running.length)} running</span>
            </>
          ) : state.limit ? (
            <>
              <PauseIcon className="size-3" />
              Rate limited<span className="max-md:hidden"> · {state.limit.provider}</span>
              {resumes}
            </>
          ) : state.held ? (
            <>
              <PauseIcon className="size-3" />
              Paused<span className="max-md:hidden"> · {state.held.source}</span>
              {resumes}
            </>
          ) : state.paused ? (
            <>
              <PauseIcon className="size-3" />
              Paused<span className="max-md:hidden"> · safe</span>
            </>
          ) : (
            <>
              <PauseIcon className="size-3" />
              <span className="max-md:hidden">Pause</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[24rem] max-w-[calc(100vw-1rem)] p-0 font-mono"
        side="top"
      >
        <Popup busy={busy} error={error} state={state} toggle={toggle} />
      </PopoverContent>
    </Popover>
  )
}

/** While paused, Play sits next to the item, one click away. */
function Play() {
  const paused = usePaused()
  const [busy, setBusy] = useState(false)
  if (!paused) return null
  return (
    <button
      className={cn(statusButton, 'text-brand')}
      data-pause-play
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void api
          .action(PlayAction)
          .catch((error: unknown) => store.notify({ level: 'error', message: errorMessage(error) }))
          .finally(() => setBusy(false))
      }}
      type="button"
    >
      <PlayIcon className="size-3" />
      Play
    </button>
  )
}

/** Under the composer while paused: what happens to a message sent now. */
function Hint() {
  if (!usePaused()) return null
  return (
    <span className="flex items-center gap-1.5 text-warning" data-pause-hint>
      <PauseIcon className="size-3" />
      Paused — your message runs on Play
    </span>
  )
}

/** The note Play leaves on a run paused mid-turn: one quiet divider. */
function Note({ entry }: { entry: EntryRecord }) {
  const note = (entry.data ?? {}) as Partial<PauseNote>
  if (note.since === undefined || note.until === undefined) return null
  return (
    <div
      className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/80 before:h-px before:flex-1 before:bg-warning/25 after:h-px after:flex-1 after:bg-warning/25"
      data-pause-note
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <PlayIcon className="size-3 shrink-0 text-warning" />
        <span className="text-warning">Paused for {lasted(note.until - note.since)}</span>
        <span className="truncate">
          ·{' '}
          {note.finished
            ? 'after its last answer'
            : note.auto
              ? 'played by itself'
              : 'continued after Play'}
        </span>
      </span>
    </div>
  )
}

/** In a parent held by the pause: which subagent hit the rate limit. One quiet divider; the child opens on click. */
function Held({ entry }: { entry: EntryRecord }) {
  const data = (entry.data ?? {}) as Partial<HeldNote>
  const { switchConversation } = useUltimate()
  if (data.child === undefined || data.provider === undefined) return null
  const child = data.child
  return (
    <div
      className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/80 before:h-px before:flex-1 before:bg-warning/25 after:h-px after:flex-1 after:bg-warning/25"
      data-pause-held
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <PauseIcon className="size-3 shrink-0 text-warning" />
        <button
          className="min-w-0 cursor-pointer truncate text-foreground hover:underline"
          onClick={() => switchConversation(child)}
          type="button"
        >
          <ConversationRef id={child} />
        </button>
        <span className="truncate">
          hit {data.provider}’s rate limit ·{' '}
          <span className="text-warning">Ultimate paused until Play</span>
        </span>
      </span>
    </div>
  )
}

/** The card a rate limit leaves in @ultimate's transcript: who limited what, and Play while this pause holds. */
function Limit({ entry }: { entry: EntryRecord }) {
  const limit = (entry.data ?? {}) as Partial<RateLimit>
  const doc = useDocOf(1, PauseDoc)
  const holding = doc?.paused === true && doc.limit?.at === limit.at
  const now = useNow(1000, holding)
  const { switchConversation } = useUltimate()
  const [busy, setBusy] = useState(false)
  if (limit.error === undefined || limit.conversationId === undefined) return null
  const conversationId = limit.conversationId
  return (
    <Card attention={holding} className="border-l-warning/60" data-pause-limit>
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <PauseIcon className="size-3.5 text-warning" />
        <span className="text-foreground">{limit.provider}</span>
        <span>rate limited · Ultimate paused</span>
        <span className="ml-auto truncate">{limit.model}</span>
      </header>
      <div className="space-y-2 px-3 py-3 text-[13px] leading-relaxed">
        <p className="whitespace-pre-wrap text-warning" title={limit.error}>
          {said(limit.error)}
        </p>
        <p className="flex flex-wrap items-center gap-1 font-mono text-[11px] text-muted-foreground">
          first hit in
          <button
            className="min-w-0 cursor-pointer text-foreground hover:underline"
            onClick={() => switchConversation(conversationId)}
            type="button"
          >
            <ConversationRef id={conversationId} />
          </button>
          · no reset time given
        </p>
        <p className="text-[12px] text-muted-foreground">
          {holding && doc.autoPlay && !doc.manual
            ? `Plays by itself ${doc.autoPlay} min after the limit, or press Play`
            : 'Nothing retries until you press Play'}
          ; held runs then continue where they stopped. A model you switch meanwhile applies on
          Play.
        </p>
      </div>
      <footer className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        {holding ? (
          <>
            <span>paused for {lasted(Math.max(0, now - (doc.since ?? now)))}</span>
            <Button
              className="h-7 font-sans text-[12px]"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                void api
                  .action(PlayAction)
                  .catch((error: unknown) =>
                    store.notify({ level: 'error', message: errorMessage(error) }),
                  )
                  .finally(() => setBusy(false))
              }}
              size="sm"
              variant="outline"
            >
              <PlayIcon className="size-3" />
              Play
            </Button>
          </>
        ) : (
          <span className="flex items-center gap-1.5">
            <PlayIcon className="size-3" />
            continued after Play
          </span>
        )}
      </footer>
    </Card>
  )
}

/** A pause that played by itself, in @ultimate's transcript: one quiet divider saying when. */
function AutoPlayedNote({ entry }: { entry: EntryRecord }) {
  const data = (entry.data ?? {}) as Partial<AutoPlayed>
  if (data.since === undefined || data.at === undefined) return null
  return (
    <div
      className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/80 before:h-px before:flex-1 before:bg-warning/25 after:h-px after:flex-1 after:bg-warning/25"
      data-pause-autoplayed
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <PlayIcon className="size-3 shrink-0 text-warning" />
        <span className="text-warning">Played by itself</span>
        <span className="truncate">
          · {lasted(data.at - data.since)}{' '}
          {data.held && data.minutes === undefined
            ? `held by ${data.held.source}`
            : 'after the rate limit'}{' '}
          · {clock(data.at)}
        </span>
      </span>
    </div>
  )
}

const paused = () => getState().docsOf[1]?.[PauseDoc.kind]?.paused === true

/** The conversations this pause parked, for the transcript and the lists of conversations. */
function useParked() {
  const pausedNow = usePaused()
  const graph = useTasks()
  return useMemo(() => parkedConversations(graph, pausedNow), [graph, pausedNow])
}

export default defineWebExtension({
  provides: [provide(ParkedRuns, useParked)],
  slots: {
    'statusline.right': [
      { component: Item, order: -3, phone: true },
      { component: Play, order: -3, phone: true },
    ],
    'composer.status': [Hint],
  },
  entries: {
    'pause.note': Note,
    'pause.limit': attention(Limit),
    'pause.autoplay': AutoPlayedNote,
    'pause.held': Held,
  },
  commands: [
    {
      id: 'pause.pause',
      title: 'Pause: stop starting new work',
      group: 'Ultimate',
      when: () => !paused(),
      run: () => api.action(PauseAction),
    },
    {
      id: 'pause.play',
      title: 'Play: continue paused work',
      group: 'Ultimate',
      when: paused,
      run: () => api.action(PlayAction),
    },
  ],
})
