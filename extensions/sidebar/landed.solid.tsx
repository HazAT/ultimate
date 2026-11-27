import type { ConversationId } from '@earendil-works/pi-durable'
import { createMemo, For, mapArray, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { events, formatAgo, keepLast, ROOT, useAction, useDocOf } from '@/sdk/solid'
import { RecentAction, TallyDoc } from '../lineage/refs.ts'
import { CommitCount } from '../workspaces/ui.solid.tsx'
import { FeatureTag } from '../conversations/ui.solid.tsx'
import { groupLandings, groupRange } from './landings.web.ts'
import type { Landing, LandingGroup } from './landings.web.ts'
import { More, Section } from './section.solid.tsx'
import { shell, useSidebarState } from './state.solid.tsx'

export function useLandings(rootIds: () => readonly ConversationId[]) {
  const reads = mapArray(rootIds, (root) => {
    const tally = useDocOf(() => root, TallyDoc)
    const recent = useAction(
      RecentAction,
      { id: root, types: ['landed'], limit: 20 },
      {
        conversation: ROOT,
        onError: keepLast,
        on: () => tally()?.tokens,
      },
    )
    return () =>
      (recent.data() ?? []).flatMap((event) =>
        event.type === 'landed' ? [{ ...event, root }] : [],
      )
  })
  return createMemo(() =>
    reads()
      .flatMap((read) => read())
      .toSorted((a, b) => (b.at ?? 0) - (a.at ?? 0)),
  )
}

const FIRST = 5

export function Landed(props: { landings: readonly Landing[]; now: number }) {
  const [all, setAll] = useSidebarState('landedAll', false)
  const groups = createMemo(() => groupLandings(props.landings))
  return (
    <Show when={groups().length > 0}>
      <Section count={groups().length} id="landed" label="Landed">
        <ul class="flex flex-col">
          <For each={all() ? groups() : groups().slice(0, FIRST)} keyed={(group) => group.label}>
            {(group) => <LandedRow group={group()} now={props.now} />}
          </For>
        </ul>
        <Show when={groups().length > FIRST}>
          <More
            all={all()}
            hidden={groups().length - FIRST}
            label="landings"
            onToggle={() => setAll(!all())}
          />
        </Show>
      </Section>
    </Show>
  )
}

function LandedRow(props: { group: LandingGroup; now: number }) {
  const latest = () => props.group.landings[0]
  const commits = createMemo(() =>
    props.group.landings.reduce((sum, landing) => sum + landing.commits, 0),
  )
  const single = () => props.group.landings.length === 1
  const from = () => (latest().from !== latest().root ? latest().from : undefined)
  const open = () => {
    const landing = latest()
    if (from() === undefined)
      events.emit('messages:open', { conversation: landing.root, entry: landing.entry })
    shell.switchConversation(from() ?? landing.root)
  }
  return (
    <li
      class="mx-2 flex h-7 min-w-0 items-center gap-1.5 rounded-md pr-2 pl-2.5 font-mono text-[10px] text-muted-foreground hover:bg-sidebar-accent/50"
      data-landed={latest().sha}
    >
      <Button
        aria-label={`Open landing ${props.group.label} · #${latest().entry}`}
        class="flex min-w-0 flex-1 items-center justify-start gap-1.5 rounded-sm text-left text-[length:inherit] leading-[inherit] font-normal outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={open}
        size={null}
        title={[
          ...new Set(
            props.group.landings.map(
              (landing) => `${landing.sha.slice(0, 7)} ${landing.title ?? props.group.label}`,
            ),
          ),
          from() !== undefined ? `Open #${from()}` : `Open #${latest().root}/${latest().entry}`,
        ].join('\n')}
        variant={null}
      >
        <Show
          when={props.group.feature}
          fallback={
            <span class="truncate font-sans text-[11.5px] text-foreground/80">
              {props.group.label}
            </span>
          }
        >
          {(feature) => <FeatureTag class="max-w-full" feature={feature()} />}
        </Show>
        <Show when={!single()}>
          <span class="shrink-0 text-muted-foreground/70">×{props.group.landings.length}</span>
        </Show>
      </Button>
      <CommitCount
        card={latest().entry}
        name={`sidebar landing #${latest().entry}`}
        class="text-muted-foreground/80"
        count={commits()}
        href={single() ? latest().compare : undefined}
        range={groupRange(props.group.landings)}
      />
      <Show when={latest().at}>
        {(at) => (
          <span
            class="w-6 shrink-0 text-right text-muted-foreground/60"
            title={new Date(at()).toLocaleString()}
          >
            {formatAgo(at(), props.now)}
          </span>
        )}
      </Show>
    </li>
  )
}
