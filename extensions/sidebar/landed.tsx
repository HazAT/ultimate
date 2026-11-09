import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { events, formatAgo, useStore } from '@/sdk'
import { reads, store } from '@/sdk/client'
import type { ReadState } from '@/sdk/reads'
import { RecentAction, TallyDoc } from '../lineage/ui.tsx'
import { groupLandings, groupRange } from './landings.ts'
import type { Landing, LandingGroup } from './landings.ts'
import { CommitCount } from '../workspaces/ui.tsx'
import { FeatureTag } from '../conversations/ui.tsx'
import { More, Section } from './section.tsx'
import { useShell, useSidebarState } from './state.tsx'

/**
 * The latest landings of every root (up to 20 each), newest first. Read again whenever a root's token count changes,
 * which every new entry in it does: a new count means something may have landed.
 */
export function useLandings(roots: readonly number[]) {
  const key = roots.join(',')
  useEffect(() => {
    const stops = roots.map((id) => store.watchDocOf(id, TallyDoc.kind))
    return () => stops.forEach((stop) => stop())
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `key` is the roots' identity
  }, [key])
  const tokens = useStore((state) =>
    roots
      .map((id) => (state.docsOf[id]?.[TallyDoc.kind] as { tokens?: number } | null)?.tokens)
      .join(','),
  )
  // The page's shared reads (`useAction`'s, one per root): a remounted sidebar, such as a phone's, shows them at once.
  const list = useMemo(
    () =>
      roots.map((id) =>
        reads.get(RecentAction.extension, RecentAction.name, { id, types: ['landed'], limit: 20 }),
      ),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `key` is the roots' identity
    [key],
  )
  useEffect(() => {
    // A root that cannot list its landings (one just unlisted) only leaves them out; the next entry reads again.
    const releases = list.map((read) => read.use({ onError: () => {} }))
    return () => releases.forEach((release) => release())
  }, [list])
  const seen = useRef(tokens)
  useEffect(() => {
    if (seen.current === tokens) return
    seen.current = tokens
    // oxlint-disable-next-line typescript/no-floating-promises -- a read reports failures and resolves undefined rather than rejecting.
    for (const read of list) void read.refetch()
  }, [list, tokens])
  const last = useRef<ReadState[]>([])
  const states = useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        const stops = list.map((read) => read.subscribe(listener))
        return () => stops.forEach((stop) => stop())
      },
      [list],
    ),
    () => {
      const next = list.map((read) => read.get())
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `states` follows `list`, which follows `key`
    [states],
  )
}

const FIRST = 5

/**
 * The lander's Landed section, under its row: what shipped, newest first, every recent landing of one feature as one
 * row with their commits summed. A row opens the branch that landed it (else the root at its landing note); the commit
 * count opens the range in Review when the landings follow each other.
 */
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
      className="mx-2 flex h-6 min-w-0 items-center gap-1.5 rounded-md pr-2 pl-2.5 font-mono text-[10px] text-muted-foreground hover:bg-sidebar-accent/50"
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
