import type { EntryRecord } from '@earendil-works/pi-durable'
import { LoaderCircleIcon, PauseIcon, PlayIcon, SquareIcon, Volume2Icon } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { cn, column, defineWebExtension, useConversation, useUltimate } from '@/sdk'
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

function ReadingStrip({ core, dock }: { core: ReactNode; dock?: boolean }) {
  const reading = useReading()
  const shown = useConversation((conversation) => conversation.id)
  const { switchConversation } = useUltimate()
  const [original, setOriginal] = useState(false)
  if (!reading) return core
  const elsewhere = shown !== reading.conversation
  const progress =
    reading.sections && reading.sections > 1 ? `${reading.section + 1}/${reading.sections}` : ''
  const shownText = original ? reading.text : reading.spoken
  return (
    <>
      <div className={cn(column(dock), 'pb-1.5')} data-read-aloud-strip={reading.entry}>
        <div className="flex flex-col gap-1.5 rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <Volume2Icon className="size-3.5 shrink-0 text-brand" />
            <button
              className="min-w-0 cursor-pointer truncate hover:text-foreground"
              onClick={() => elsewhere && switchConversation(reading.conversation)}
              title={elsewhere ? `Open #${reading.conversation}` : undefined}
              type="button"
            >
              {reading.status === 'loading'
                ? 'Preparing…'
                : reading.status === 'paused'
                  ? 'Paused'
                  : 'Reading'}
              {elsewhere ? ` · #${reading.conversation}` : ''}
              {progress && ` · ${progress}`}
            </button>
            <button
              className="ml-auto shrink-0 cursor-pointer hover:text-foreground"
              onClick={() => setOriginal(!original)}
              type="button"
            >
              {original ? 'spoken' : 'original'}
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
          {reading.error ? (
            <p className="font-mono text-[11px] text-error">{reading.error}</p>
          ) : (
            shownText && (
              <p className="max-h-24 overflow-y-auto text-[12.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {shownText}
              </p>
            )
          )}
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
