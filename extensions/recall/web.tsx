import { deadline } from '../../lib/timers.ts'
import type { Cancel } from '../../lib/timers.ts'
import { useEffect, useRef, useState } from 'react'
import { cn, defineWebExtension, useDoc, useTranscript } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { MemoryChip } from '../lineage/ui.tsx'
import { RecallDoc } from './refs.ts'
import { RECALL_ENTRY } from './types.ts'
import type { Recalled } from './types.ts'

/**
 * On the user's bubble: while recall checks the message, a band of light runs around its border and fades; recalled
 * memories then fly in as chips hanging on its bottom edge, each opening the Memory surface. Nothing when none applies.
 */
function RecallBubble({ entry }: { entry: EntryRecord }) {
  const pending = useDoc(RecallDoc)?.pending === entry.id
  const recalled = useTranscript().find(
    (other) => other.kind === RECALL_ENTRY && (other.data as Recalled).input === entry.id,
  )?.data as Recalled | undefined
  // Mounted once this view saw the check start, so the fade-out and the fly-in play; history shows chips still.
  const [watched, setWatched] = useState(false)
  // A check takes about 0.2 s: the light runs at least one lap so it reads as a check, not a flicker.
  const [lap, setLap] = useState(false)
  // Started when the check starts and left running when it ends early; only unmounting cancels it.
  const cancelLap = useRef<Cancel>(undefined)
  useEffect(() => {
    if (!pending) return
    setWatched(true)
    setLap(true)
    cancelLap.current?.()
    cancelLap.current = deadline(1200, () => setLap(false))
  }, [pending])
  useEffect(() => () => cancelLap.current?.(), [])
  const checking = pending || lap
  return (
    <>
      {watched && (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 rounded-lg p-px transition-opacity duration-700',
            checking ? 'opacity-100' : 'opacity-0',
          )}
          data-recall-checking={checking || undefined}
          style={{
            // One lap of the band across the border per minimum check time.
            animation: checking ? 'sweep 1.2s linear infinite' : undefined,
            background:
              'linear-gradient(90deg, transparent 30%, var(--color-brand) 50%, transparent 70%) 0 0 / 300% 100%',
            mask: 'linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0)',
          }}
        />
      )}
      {recalled && !checking && <Chips animate={watched} recalled={recalled} />}
    </>
  )
}

function Chips({ recalled, animate }: { recalled: Recalled; animate: boolean }) {
  const row = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!animate) return
    row.current?.querySelectorAll('button').forEach((chip, index) =>
      chip.animate(
        [
          { opacity: 0, transform: 'translateY(-8px) scale(0.9)' },
          { opacity: 1, transform: 'none' },
        ],
        {
          duration: 450,
          delay: index * 80,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'backwards',
        },
      ),
    )
  }, [animate])
  return (
    <div
      className="absolute -bottom-2.5 left-3 flex max-w-[calc(100%-1.5rem)] flex-wrap gap-1"
      data-recall={recalled.input}
      ref={row}
    >
      {recalled.memories.map(({ slug, line }) => (
        <MemoryChip
          data-recall-memory={slug}
          key={slug}
          slug={slug}
          title={`Recalled from memory: ${line}`}
        />
      ))}
    </div>
  )
}

export default defineWebExtension({
  userBubble: [RecallBubble],
  // The bubble shows what was recalled; the entry carries the memories for the model.
  entries: { [RECALL_ENTRY]: () => null },
})
