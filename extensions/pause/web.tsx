import { ROOT } from '@/sdk'
import { PauseIcon, PlayIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  api,
  attention,
  Card,
  defineWebExtension,
  errorMessage,
  getState,
  island,
  ParkedRuns,
  provide,
  useDocOf,
  useNow,
  useTasks,
  useUltimate,
} from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { store } from '@/sdk/client'
import { ConversationRef } from '../conversations/ui.tsx'
import { lasted, unwrappedProviderError } from './lasted.ts'
import { parkedConversations } from './parked.ts'
import { PauseAction, PauseDoc, PlayAction } from './refs.ts'
import type { AutoPlayed, HeldNote, PauseNote, RateLimit } from './refs.ts'
import { Item, Play } from './status.solid.tsx'

const usePaused = () => useDocOf(ROOT, PauseDoc)?.paused === true

function Hint() {
  if (!usePaused()) return null
  return (
    <span className="flex items-center gap-1.5 text-warning" data-pause-hint>
      <PauseIcon className="size-3" />
      Paused — your message runs on Play
    </span>
  )
}

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

function Held({ entry }: { entry: EntryRecord }) {
  const data = (entry.data ?? {}) as Partial<HeldNote>
  const { switchConversation } = useUltimate()
  if (data.child === undefined || data.provider === undefined) return null
  const { child } = data
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

function Limit({ entry }: { entry: EntryRecord }) {
  const limit = (entry.data ?? {}) as Partial<RateLimit>
  const doc = useDocOf(ROOT, PauseDoc)
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
          {unwrappedProviderError(limit.error)}
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
          · {lasted(data.at - data.since)} after the rate limit ·{' '}
          {new Date(data.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </span>
    </div>
  )
}

const paused = () => getState().docsOf[1]?.[PauseDoc.kind]?.paused === true

function useParked() {
  const pausedNow = usePaused()
  const graph = useTasks()
  return useMemo(() => parkedConversations(graph, pausedNow), [graph, pausedNow])
}

export default defineWebExtension({
  provides: [provide(ParkedRuns, useParked)],
  slots: {
    'statusline.right': [
      { component: island(Item), order: -3, phone: true },
      { component: island(Play), order: -3, phone: true },
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
