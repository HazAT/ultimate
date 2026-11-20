import { InboxIcon } from 'lucide-react'
import {
  Header,
  Provided,
  Sidebar,
  defineWebExtension,
  island,
  provide,
  useNow,
  useUltimate,
  useViewport,
} from '@/sdk'
import type { Message } from '../messages/refs.ts'
import { UnderUltimate } from '../sidebar/ui.tsx'
import { Badge, LinkOverlay, SidebarRow, Zero } from './chrome.solid.tsx'
import { SURFACE, answeredToday, toRow } from './items.ts'
import type { Entry } from './items.ts'
import { List } from './list.solid.tsx'
import { Reading } from './reading.tsx'
import { useSelection } from './selection.tsx'
import { QuestionPane, Waiting } from './ui.tsx'

const ListIsland = island(List)
const ZeroIsland = island(Zero)
const BadgeIsland = island(Badge)
const SidebarIsland = island(SidebarRow)
const LinkIsland = island(LinkOverlay)

function Inbox() {
  return (
    <Waiting>{(entries, messages) => <Surface entries={entries} messages={messages} />}</Waiting>
  )
}

function Surface({ entries, messages }: { entries: Entry[]; messages: readonly Message[] }) {
  const phone = useViewport() === 'phone'
  const now = useNow(60_000)
  const { shown: item, selected, setSelected } = useSelection(entries)
  const list = <ListIsland phone={phone} rows={entries.map(toRow)} />
  const reading = item && (
    <Reading
      entry={item}
      key={item.key}
      now={now}
      onBack={() => setSelected((current) => current && { ...current, open: false })}
      phone={phone}
    />
  )

  return (
    <Provided input={{ message: item?.message, phone }} point={QuestionPane}>
      {(takeover) => {
        const phonePane = takeover ?? (selected?.open ? reading : undefined)
        return (
          <div className="flex min-h-0 flex-1">
            <Sidebar />
            <main className="flex min-w-0 flex-1 flex-col">
              {!(phone && phonePane) && (
                <Header>
                  <span className="flex shrink-0 items-center gap-2 text-[13px] font-medium">
                    <InboxIcon className="size-4 text-muted-foreground" />
                    Inbox <BadgeIsland count={entries.length} />
                  </span>
                </Header>
              )}
              {!entries.length && !takeover ? (
                <ZeroIsland today={answeredToday(messages, now)} />
              ) : phone ? (
                (phonePane ?? list)
              ) : (
                <div className="flex min-h-0 flex-1">
                  <div className="flex w-[24rem] shrink-0 flex-col border-r border-border/70">
                    {list}
                  </div>
                  {takeover ?? reading}
                </div>
              )}
            </main>
          </div>
        )
      }}
    </Provided>
  )
}

function useInboxSidebar() {
  const active = useUltimate().surface === SURFACE
  return (
    <Waiting>
      {(entries) => (
        <SidebarIsland active={active} count={entries.length} oldest={entries[0]?.at} />
      )}
    </Waiting>
  )
}

function WaitingBadge() {
  return <Waiting>{(entries) => <BadgeIsland count={entries.length} />}</Waiting>
}

function WaitingLink() {
  return (
    <Waiting>
      {(entries) => <LinkIsland entries={entries.map(({ key, at }) => ({ key, at }))} />}
    </Waiting>
  )
}

export default defineWebExtension({
  slots: { overlay: [WaitingLink] },
  surfaces: [
    {
      id: SURFACE,
      title: 'Inbox',
      icon: InboxIcon,
      description: 'Everything that waits on you, oldest first, answered in place',
      order: 10,
      component: Inbox,
      badge: WaitingBadge,
    },
  ],
  commands: [
    {
      id: 'inbox.open',
      title: 'Open Inbox',
      run: (context) => context.showSurface(SURFACE),
    },
  ],
  provides: [provide(UnderUltimate, useInboxSidebar)],
})
