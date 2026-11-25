import { Inbox as InboxIcon } from '@lucide/solid'
import { createEffect, createMemo, For, Show } from 'solid-js'
import { Header, Sidebar, useProvided, useNow, useSurface, useViewport } from '@/sdk/solid'
import { Badge, LinkOverlay, SidebarRow, Zero, showOnAppIcon } from './chrome.solid.tsx'
import { SURFACE, answeredToday, toRow } from './items.ts'
import { List } from './list.solid.tsx'
import { QuestionPane } from './points.ts'
import { Reading } from './reading.solid.tsx'
import { useSelection } from './selection.solid.tsx'
import { Waiting } from './ui.solid.tsx'

export function Inbox() {
  const { entries, messages, failures } = Waiting()
  const viewport = useViewport()
  const phone = () => viewport() === 'phone'
  const now = useNow(60_000)
  const { item, selected, setSelected } = useSelection(entries)
  const rows = createMemo(() => entries().map(toRow))
  const paneFailures = (<span class="contents" />) as HTMLElement
  const takeover = useProvided(
    QuestionPane,
    () => ({ message: item()?.message, phone: phone() }),
    paneFailures,
  )
  const reading = () => takeover() != null || (!!item() && !!selected()?.open)
  const close = () => setSelected((current) => current && { ...current, open: false })
  const openItem = createMemo(() => {
    const entry = item()
    return entry ? [entry] : []
  })
  const pane = () => (
    <Show
      when={takeover()}
      fallback={
        <For each={openItem()} keyed={(entry) => entry.key}>
          {(entry) => <Reading entry={entry()} now={now()} onBack={close} phone={phone()} />}
        </For>
      }
    >
      {(render) => render()()}
    </Show>
  )
  return (
    <div class="flex min-h-0 flex-1">
      <Sidebar />
      <main class="flex min-w-0 flex-1 flex-col">
        <Show when={!phone() || !reading()}>
          <Header>
            <span class="flex shrink-0 items-center gap-2 text-[13px] font-medium">
              <InboxIcon class="size-4 text-muted-foreground" />
              Inbox <Badge count={entries().length} />
            </span>
          </Header>
        </Show>
        <div class="flex flex-col gap-1 px-3 has-[[data-extension-error]]:py-1.5">
          {failures}
          {paneFailures}
        </div>
        <Show
          when={entries().length > 0 || takeover() != null}
          fallback={<Zero today={answeredToday(messages(), now())} />}
        >
          <Show
            when={!phone()}
            fallback={
              <Show when={reading()} fallback={<List phone rows={rows()} />}>
                {pane()}
              </Show>
            }
          >
            <div class="flex min-h-0 flex-1">
              <div class="flex w-[24rem] shrink-0 flex-col border-r border-border/70">
                <List phone={false} rows={rows()} />
              </div>
              {pane()}
            </div>
          </Show>
        </Show>
      </main>
    </div>
  )
}

export function InboxSidebar() {
  const active = useSurface()
  const { entries, failures } = Waiting()
  return (
    <>
      <SidebarRow
        active={active() === SURFACE}
        count={entries().length}
        oldest={entries()[0]?.at}
      />
      {failures}
    </>
  )
}

export function WaitingBadge() {
  const { entries, failures } = Waiting()
  return (
    <>
      <Badge count={entries().length} />
      {failures}
    </>
  )
}

export function AppBadge() {
  const { entries, loaded } = Waiting()
  const count = createMemo(() => (loaded() ? entries().length : undefined))
  createEffect(count, (shown) => {
    if (shown !== undefined) showOnAppIcon(shown)
  })
  return null
}

export function WaitingLink() {
  const { entries } = Waiting()
  return <LinkOverlay entries={entries()} />
}
