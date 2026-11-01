import { useEffect, useState } from 'react'
import { api, events, formatAgo, useStore } from '@/sdk'
import { store } from '@/sdk/client'
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
  const [landings, setLandings] = useState<Landing[]>([])
  useEffect(() => {
    let live = true
    void Promise.all(
      roots.map((root) =>
        api
          .action(RecentAction, { id: root, types: ['landed'], limit: 20 })
          .then((recent) => (recent as Landing[]).map((event) => ({ ...event, root })))
          // A root that cannot list its landings (one just unlisted) only leaves them out; the next entry reads again.
          .catch(() => [] as Landing[]),
      ),
    )
      .then((all) => {
        if (live) setLandings(all.flat().toSorted((a, b) => (b.at ?? 0) - (a.at ?? 0)))
      })
      .catch(() => {
        // Each root's call already settles to a list, so nothing reaches here.
      })
    return () => {
      live = false
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `key` is the roots' identity
  }, [key, tokens])
  return landings
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
      className="mx-2 flex h-6 min-w-0 items-center gap-1.5 rounded-md pr-2 pl-2.5 font-mono text-[0.625rem] text-muted-foreground hover:bg-sidebar-accent/50"
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
          <span className="truncate font-sans text-[0.7188rem] text-foreground/80">
            {group.label}
          </span>
        )}
        {!single && (
          <span className="shrink-0 text-muted-foreground">×{group.landings.length}</span>
        )}
      </button>
      <CommitCount
        className="text-muted-foreground"
        count={commits}
        href={single ? latest.compare : undefined}
        range={groupRange(group.landings)}
      />
      {latest.at !== undefined && (
        <span
          className="w-6 shrink-0 text-right text-muted-foreground"
          title={new Date(latest.at).toLocaleString()}
        >
          {formatAgo(latest.at, now)}
        </span>
      )}
    </li>
  )
}
