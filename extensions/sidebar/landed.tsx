import { parseConversationId } from '../../lib/ids.ts'
import type { ConversationId } from '@earendil-works/pi-durable'
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { events, formatAgo, keepLast, useStore } from '@/sdk'
import { reads, store } from '@/sdk/client'
import type { ReadState } from '@/sdk/reads'
import { RecentAction, TallyDoc } from '../lineage/ui.tsx'
import { groupLandings, groupRange } from './landings.ts'
import type { Landing, LandingGroup } from './landings.ts'
import { CommitCount } from '../workspaces/ui.tsx'
import { FeatureTag } from '../conversations/ui.tsx'
import { More, Section } from './section.tsx'
import { useShell, useSidebarState } from './state.tsx'

export function useLandings(rootIds: readonly ConversationId[]) {
  const key = rootIds.join(',')
  const roots = useMemo(
    () => (key ? key.split(',').map((id) => parseConversationId(Number(id))) : []),
    [key],
  )
  useEffect(() => {
    const stops = roots.map((id) => store.watchDocOf(id, TallyDoc.kind))
    return () => stops.forEach((stop) => stop())
  }, [roots])
  const tokens = useStore((state) =>
    roots
      .map((id) => (state.docsOf[id]?.[TallyDoc.kind] as { tokens?: number } | null)?.tokens)
      .join(','),
  )
  const sharedLandingReads = useMemo(
    () =>
      roots.map((id) =>
        reads.get(RecentAction.extension, RecentAction.name, { id, types: ['landed'], limit: 20 }),
      ),
    [roots],
  )
  useEffect(() => {
    const releases = sharedLandingReads.map((read) => read.use({ onError: keepLast }))
    return () => releases.forEach((release) => release())
  }, [sharedLandingReads])
  const seen = useRef(tokens)
  useEffect(() => {
    if (seen.current === tokens) return
    seen.current = tokens
    for (const read of sharedLandingReads) void read.refetch()
  }, [sharedLandingReads, tokens])
  const last = useRef<ReadState[]>([])
  const states = useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        const stops = sharedLandingReads.map((read) => read.subscribe(listener))
        return () => stops.forEach((stop) => stop())
      },
      [sharedLandingReads],
    ),
    () => {
      const next = sharedLandingReads.map((read) => read.get())
      const same =
        next.length === last.current.length && next.every((state, i) => state === last.current[i])
      if (!same) last.current = next
      return last.current
    },
  )
  return useMemo(
    () =>
      states
        .flatMap((state, index) =>
          ((state.data as Landing[] | undefined) ?? []).map((event) => ({
            ...event,
            root: roots[index],
          })),
        )
        .toSorted((a, b) => (b.at ?? 0) - (a.at ?? 0)),
    [states, roots],
  )
}

const FIRST = 5

export function Landed({ landings, now }: { landings: readonly Landing[]; now: number }) {
  const [all, setAll] = useSidebarState<boolean>('landedAll', false)
  const groups = groupLandings(landings)
  if (!groups.length) return null
  return (
    <Section count={groups.length} id="landed" label="Landed">
      <ul className="flex flex-col">
        {(all ? groups : groups.slice(0, FIRST)).map((group) => (
          <LandedRow group={group} key={group.landings[0].entry} now={now} />
        ))}
      </ul>
      {groups.length > FIRST && (
        <More all={all} hidden={groups.length - FIRST} onToggle={() => setAll(!all)} />
      )}
    </Section>
  )
}

function LandedRow({ group, now }: { group: LandingGroup; now: number }) {
  const actions = useShell()
  const latest = group.landings[0]
  const commits = group.landings.reduce((sum, landing) => sum + landing.commits, 0)
  const single = group.landings.length === 1
  const from = latest.from !== undefined && latest.from !== latest.root ? latest.from : undefined
  const open = () => {
    if (from === undefined)
      events.emit('messages:open', { conversation: latest.root, entry: latest.entry })
    actions.showSurface('agent')
    actions.switchConversation(from ?? latest.root)
  }
  return (
    <li
      className="mx-2 flex h-7 min-w-0 items-center gap-1.5 rounded-md pr-2 pl-2.5 font-mono text-[10px] text-muted-foreground hover:bg-sidebar-accent/50"
      data-landed={latest.sha}
    >
      <button
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={open}
        title={[
          ...new Set(
            group.landings.map(
              (landing) => `${landing.sha.slice(0, 7)} ${landing.title ?? group.label}`,
            ),
          ),
          from !== undefined ? `Open #${from}` : `Open #${latest.root}/${latest.entry}`,
        ].join('\n')}
        type="button"
      >
        {group.feature ? (
          <FeatureTag className="max-w-full" feature={group.feature} />
        ) : (
          <span className="truncate font-sans text-[11.5px] text-foreground/80">{group.label}</span>
        )}
        {!single && (
          <span className="shrink-0 text-muted-foreground/70">×{group.landings.length}</span>
        )}
      </button>
      <CommitCount
        className="text-muted-foreground/80"
        count={commits}
        href={single ? latest.compare : undefined}
        range={groupRange(group.landings)}
      />
      {latest.at !== undefined && (
        <span
          className="w-6 shrink-0 text-right text-muted-foreground/60"
          title={new Date(latest.at).toLocaleString()}
        >
          {formatAgo(latest.at, now)}
        </span>
      )}
    </li>
  )
}
