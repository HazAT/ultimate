import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { LoaderCircleIcon, PauseIcon, PlayIcon, SquareIcon, Volume2Icon } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import {
  cn,
  column,
  defineWebExtension,
  events,
  useConversation,
  useExtensionUiState,
  useUltimate,
} from '@/sdk'
import * as player from './player.tsx'

const useReading = () => useSyncExternalStore(player.subscribe, player.current)

const rowButton =
  'cursor-pointer rounded p-0.5 transition-colors hover:text-foreground [&_svg]:size-3'

function ReadAloudAction({ entry, text }: { entry: EntryRecord; text: string }) {
  const reading = useReading()
  if (!text.trim() || entry.model?.[0]?.role === 'user') return null
  const mine = reading?.conversation === entry.conversationId && reading.entry === entry.id
  const label = !mine ? 'Read aloud' : reading.status === 'playing' ? 'Pause' : 'Resume'
  return (
    <button
      aria-label={label}
      className={cn(rowButton, mine && 'text-brand')}
      data-read-aloud={entry.id}
      onClick={() =>
        !mine
          ? player.read(entry.conversationId, entry.id, text)
          : reading.status === 'playing'
            ? player.pause()
            : player.resume()
      }
      title={label}
      type="button"
    >
      {mine && reading.status === 'loading' ? (
        <LoaderCircleIcon className="motion-safe:animate-spin" />
      ) : mine && reading.status === 'playing' ? (
        <PauseIcon />
      ) : (
        <Volume2Icon />
      )}
    </button>
  )
}

const speeds = [1, 1.25, 1.5, 1.75, 2, 0.75]

function ReadingStrip({ core, dock }: { core: ReactNode; dock?: boolean }) {
  const reading = useReading()
  const { id: shown, loading } = useConversation()
  const { switchConversation } = useUltimate()
  const [rate, setRate] = useExtensionUiState('rate', 1)
  const [revealing, setRevealing] = useState<{ conversation: ConversationId; entry: number }>()
  useEffect(() => player.setRate(rate), [rate])
  useEffect(() => {
    if (!revealing || revealing.conversation !== shown || loading) return
    events.emit('ultimate:reveal-entry', {
      conversationId: revealing.conversation,
      entryId: revealing.entry,
    })
    setRevealing(undefined)
  }, [revealing, shown, loading])
  if (!reading) return core
  const progress =
    reading.sections && reading.sections > 1 ? ` · ${reading.section + 1}/${reading.sections}` : ''
  const goToMessage = () => {
    if (shown !== reading.conversation) switchConversation(reading.conversation)
    setRevealing({ conversation: reading.conversation, entry: reading.entry })
  }
  return (
    <>
      <div className={cn(column(dock), 'pb-1.5')} data-read-aloud-strip={reading.entry}>
        <div
          className="flex min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-2.5 py-1 font-mono text-[11px] text-muted-foreground"
          title={reading.error}
        >
          <Volume2Icon
            className={cn('size-3.5 shrink-0', reading.error ? 'text-error' : 'text-brand')}
          />
          <button
            className="min-w-0 cursor-pointer truncate hover:text-foreground"
            onClick={goToMessage}
            title="Show the message"
            type="button"
          >
            {reading.error
              ? 'Could not read'
              : reading.status === 'loading'
                ? 'Preparing'
                : reading.status === 'paused'
                  ? 'Paused'
                  : 'Reading'}{' '}
            <span className="underline decoration-muted-foreground/40 underline-offset-2">
              #{reading.conversation}/{reading.entry}
            </span>
            {progress}
          </button>
          <button
            aria-label="Reading speed"
            className="ml-auto shrink-0 cursor-pointer rounded px-1 tabular-nums transition-colors hover:text-foreground"
            onClick={() => setRate(speeds[(speeds.indexOf(rate) + 1) % speeds.length])}
            title="Reading speed"
            type="button"
          >
            {rate}×
          </button>
          <button
            aria-label={reading.status === 'playing' ? 'Pause' : 'Resume'}
            className={rowButton}
            disabled={reading.status === 'loading'}
            onClick={reading.status === 'playing' ? player.pause : player.resume}
            title={reading.status === 'playing' ? 'Pause' : 'Resume'}
            type="button"
          >
            {reading.status === 'loading' ? (
              <LoaderCircleIcon className="motion-safe:animate-spin" />
            ) : reading.status === 'playing' ? (
              <PauseIcon />
            ) : (
              <PlayIcon />
            )}
          </button>
          <button
            aria-label="Stop"
            className={rowButton}
            onClick={player.stop}
            title="Stop"
            type="button"
          >
            <SquareIcon />
          </button>
        </div>
      </div>
      {core}
    </>
  )
}

export default defineWebExtension({
  messageActions: [ReadAloudAction],
  composer: ReadingStrip,
})
