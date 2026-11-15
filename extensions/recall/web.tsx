import { deadline } from '../../lib/timers.ts'
import type { Cancel } from '../../lib/timers.ts'
import { useEffect, useRef, useState } from 'react'
import { cn, defineWebExtension, useDoc, useTranscript } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { MemoryChip } from '../lineage/ui.tsx'
import { RecallDoc } from './refs.ts'
import { RecalledEntry } from './types.ts'
import type { Recalled } from './types.ts'

function RecallBubble({ entry }: { entry: EntryRecord }) {
  const pending = useDoc(RecallDoc)?.pending === entry.id
  const recalled = useTranscript()
    .filter((candidate) => RecalledEntry.is(candidate))
    .find((other) => other.data.input === entry.id)?.data
  const [checkStartedInThisView, setCheckStartedInThisView] = useState(false)
  const [minimumSweepStillRunning, setMinimumSweepStillRunning] = useState(false)
  const cancelSweepOnUnmount = useRef<Cancel>(undefined)
  useEffect(() => {
    if (!pending) return
    setCheckStartedInThisView(true)
    setMinimumSweepStillRunning(true)
    cancelSweepOnUnmount.current?.()
    cancelSweepOnUnmount.current = deadline(1200, () => setMinimumSweepStillRunning(false))
  }, [pending])
  useEffect(() => () => cancelSweepOnUnmount.current?.(), [])
  const checking = pending || minimumSweepStillRunning
  return (
    <>
      {checkStartedInThisView && (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 rounded-lg p-px transition-opacity duration-700',
            checking ? 'opacity-100' : 'opacity-0',
          )}
          data-recall-checking={checking || undefined}
          style={{
            animation: checking ? 'sweep 1.2s linear infinite' : undefined,
            background:
              'linear-gradient(90deg, transparent 30%, var(--color-brand) 50%, transparent 70%) 0 0 / 300% 100%',
            mask: 'linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0)',
          }}
        />
      )}
      {recalled && !checking && <Chips animate={checkStartedInThisView} recalled={recalled} />}
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

const ModelOnlyRecalledMemories = () => null

export default defineWebExtension({
  userBubble: [RecallBubble],
  entries: { [RecalledEntry.kind]: ModelOnlyRecalledMemories },
})
