import { MoonIcon } from 'lucide-react'
import { Card } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import type { RequestedEntry } from './refs.ts'

/** How long the user was away, in whole hours: `9 h`. */
const awayFor = (ms: number) => `${Math.max(1, Math.round(ms / 3600_000))} h`

/** `dream.ready`: the user pressed Fall asleep after a dream; @ultimate prepares the chapter. One quiet line. */
export function ReadyCard({ entry }: { entry: EntryRecord }) {
  const { branch } = (entry.data ?? {}) as { branch?: number }
  return (
    <Card data-dream-ready={branch}>
      <p className="flex flex-wrap items-center gap-2 px-3 py-2 font-mono text-[0.6875rem] text-muted-foreground">
        <MoonIcon className="size-3.5 text-brand" />
        <span className="text-foreground">Fall asleep</span>
        <span>you pressed it after dream #{branch} · preparing the next chapter</span>
      </p>
    </Card>
  )
}

/** `dream.requested`: a dream was asked for, by the user's Dream button or a built-in automation. One quiet line. */
export function RequestedCard({ entry }: { entry: EntryRecord }) {
  const { automation } = (entry.data ?? {}) as RequestedEntry
  return (
    <Card data-dream-requested={automation?.id ?? 'user'}>
      <p className="flex flex-wrap items-center gap-2 px-3 py-2 font-mono text-[0.6875rem] text-muted-foreground">
        <MoonIcon className="size-3.5 text-brand" />
        <span className="text-foreground">Time to dream</span>
        <span>
          {automation
            ? `${automation.pause !== undefined ? `you were away ${awayFor(automation.pause)}` : 'my context filled up'} · automation ${automation.id}`
            : 'you pressed Dream'}
        </span>
      </p>
    </Card>
  )
}
