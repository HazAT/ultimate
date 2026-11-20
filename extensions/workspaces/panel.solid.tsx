/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { RefreshCw } from '@lucide/solid'
import { For, Show, createMemo } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { CopyValue } from '@/components/ui/copy-value.solid.tsx'
import { Row, Rows } from '@/components/ui/rows.solid.tsx'
import {
  ROOT,
  cn,
  elidePath,
  formatBytes,
  keepLast,
  plural,
  shortenPath,
  useAction,
  useConversationId,
  useConversations,
  useDocOf,
  useSystem,
} from '@/sdk/solid'
import { ConversationRef } from '../conversations/ui.solid.tsx'
import { DiskAction, InfoAction, StatsAction, WorkspacesDoc } from './refs.ts'
import type { QueueEntry, Workspace, WorkspaceIndex } from './types.ts'

const heading = 'mb-1 font-mono text-[10.5px] text-muted-foreground/70'
const stateLabels = {
  preparing: 'Setting up…',
  ready: 'Ready',
  failed: 'Setup failed',
  removed: 'Removed',
}
function useWorkspaceView() {
  const index = useDocOf(() => ROOT, WorkspacesDoc)
  const id = useConversationId()
  const conversations = useConversations()
  const shown = createMemo(() => conversations().find((row) => row.id === id()))
  return {
    index,
    shown,
    workspace: () => index()?.items[String(shown()?.id)],
    queue: () => index()?.queue ?? [],
  }
}

export function useWorkspacesMeta() {
  const { queue, workspace } = useWorkspaceView()
  return () => {
    const count = queue().length
    if (count) return `${count} landing`
    const state = workspace()?.state
    return state ? stateLabels[state].toLowerCase() : 'shared checkout'
  }
}

export function Workspaces() {
  const { index, shown, workspace, queue } = useWorkspaceView()
  return (
    <div class="flex flex-col gap-3" data-workspaces>
      <LanderQueue queue={queue()} />
      <Show
        keyed
        when={workspace() && shown()?.id}
        fallback={
          <p class="font-mono text-[11px] text-muted-foreground/60">
            shown conversation works in the shared checkout
          </p>
        }
      >
        {(id) => (
          <Checkout
            busy={shown()!.busy}
            id={id}
            queued={queue().find((item) => item.conversationId === id)}
            recorded={workspace()!}
          />
        )}
      </Show>
      <Stats records={index()?.items} />
    </div>
  )
}

function Checkout(props: {
  busy: boolean
  id: ConversationId
  queued?: QueueEntry
  recorded: Workspace
}) {
  const info = useAction(
    InfoAction,
    {
      get id() {
        return props.id
      },
    },
    {
      onError: keepLast,
      on: () => [props.recorded.state, props.recorded.landed, props.busy],
      focus: true,
    },
  )
  const workspace = createMemo(() => {
    const live = info.data()
    const recorded = props.recorded
    return live?.state === recorded.state && live.landed === recorded.landed ? live : recorded
  })
  const ahead = () => info.data()?.ahead
  const system = useSystem()
  const status = () => {
    const queued = props.queued
    return queued
      ? queued.state === 'landing'
        ? 'landing…'
        : 'queued'
      : stateLabels[props.recorded.state]
  }
  const error = () => (workspace().state === 'failed' ? workspace().error : info.error()?.message)
  return (
    <div data-workspace={props.id}>
      <div class={cn(heading, 'flex items-center gap-1.5')}>
        <span>this checkout</span>
        <span
          class={
            props.queued
              ? 'text-brand'
              : props.recorded.state === 'failed'
                ? 'text-error'
                : 'text-muted-foreground'
          }
        >
          · {status()}
        </span>
        <Button
          aria-label={`Refresh checkout #${props.id}`}
          class="ml-auto size-5 text-muted-foreground hover:text-foreground"
          disabled={info.loading()}
          onClick={() => info.refetch()}
          size="icon-xs"
          variant="ghost"
        >
          <RefreshCw class={cn('size-3', info.loading() && 'animate-spin')} />
        </Button>
      </div>
      <Rows>
        <Row label="path">
          <CopyValue field="checkout path" value={workspace().path}>
            {elidePath(shortenPath(workspace().path, { home: system()?.machine.home }), 34)}
          </CopyValue>
        </Row>
        <Row label="branch">
          <CopyValue field="checkout branch" value={workspace().branch} />
        </Row>
        <Row label="target">
          <span class="truncate">
            {workspace().target}
            <span class="text-muted-foreground/60"> in {workspace().source}</span>
          </span>
        </Row>
        <Show when={typeof ahead() === 'number'}>
          <Row label="ahead">{plural(ahead()!, 'commit')}</Row>
        </Show>
        <Show when={workspace().landed}>
          {(sha) => <Row label="landed">{sha().slice(0, 7)}</Row>}
        </Show>
      </Rows>
      <Show when={error()}>
        <p
          class="mt-1.5 font-mono text-[11px] break-words whitespace-pre-wrap text-error"
          role="alert"
        >
          {error()}
        </p>
      </Show>
    </div>
  )
}

function LanderQueue(props: { queue: QueueEntry[] }) {
  return (
    <Show when={props.queue.length}>
      <section aria-label="Lander queue">
        <h3 class={heading}>lander queue</h3>
        <ol class="flex flex-col gap-0.5 font-mono text-[11.5px]">
          <For each={props.queue} keyed={(item) => item.id}>
            {(item) => (
              <li class="flex min-w-0 items-center gap-2">
                <ConversationRef class="max-w-1/2" id={item().conversationId} />
                <span class="shrink-0 text-muted-foreground">{item().tip.slice(0, 7)}</span>
                <span
                  class={cn(
                    'min-w-0 flex-1 truncate',
                    item().state === 'landing' ? 'text-brand' : 'text-muted-foreground',
                  )}
                >
                  {item().state === 'landing'
                    ? (item().step ?? 'landing')
                    : `queued for ${item().target}`}
                </span>
              </li>
            )}
          </For>
        </ol>
      </section>
    </Show>
  )
}

const parts = (entries: [number, string][]) =>
  entries
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`)
    .join(' · ') || 'none'

function Stats(props: { records?: WorkspaceIndex['items'] }) {
  const states = () =>
    Object.entries(props.records ?? {}).map(([id, record]) => [id, record.state, record.landed])
  const stats = useAction(StatsAction, null, { on: states, focus: true })
  const disk = useAction(DiskAction, null, { focus: true })
  return (
    <Show
      when={!stats.error()}
      fallback={<p class="font-mono text-[11px] text-error">{stats.error()?.message}</p>}
    >
      <Show when={stats.data()}>
        {(data) => (
          <section aria-label="Workspace statistics">
            <h3 class={heading}>all checkouts</h3>
            <Rows>
              <Row label="checkouts">
                <span class="truncate">
                  {data().total - data().removed}
                  {data().removed > 0 && (
                    <span class="text-muted-foreground/70"> · {data().removed} removed</span>
                  )}
                </span>
              </Row>
              <Row label="state">
                <span class="truncate">
                  {parts([
                    [data().ready, 'ready'],
                    [data().preparing, 'setting up'],
                    [data().failed, 'failed'],
                  ])}
                </span>
              </Row>
              <Row label="commits">
                <span class="truncate">
                  {parts([
                    [data().landed, 'landed'],
                    [data().ahead, 'ahead'],
                    [data().fresh, 'none yet'],
                  ])}
                </span>
              </Row>
              <Row label="uncommitted">{data().dirty}</Row>
              <Row label="disk">
                <span
                  class="truncate"
                  title="Each checkout's blocks added up; copy-on-write checkouts share many of them"
                >
                  <Show
                    when={disk.data()}
                    fallback={<span class="text-muted-foreground/70">measuring…</span>}
                  >
                    {(space) => (
                      <>
                        {space().bytes === null ? 'unknown' : formatBytes(space().bytes!)}
                        <Show when={space().bytes !== null && space().real != null}>
                          <span
                            class="text-muted-foreground/60"
                            title="Blocks shared between checkouts counted once (btrfs)"
                          >
                            {' '}
                            · {formatBytes(space().real!)} real
                          </span>
                        </Show>
                      </>
                    )}
                  </Show>
                </span>
              </Row>
            </Rows>
          </section>
        )}
      </Show>
    </Show>
  )
}
