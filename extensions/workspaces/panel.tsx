import { CopyIcon, RefreshCwIcon } from 'lucide-react'
import { useMemo } from 'react'
import { Row, Rows } from '@/components/ui/rows'
import {
  cn,
  elidePath,
  formatBytes,
  shortenPath,
  useAction,
  useConversation,
  useConversationSummary,
  useSystem,
} from '@/sdk'
import { ConversationRef } from '../conversations/ui.tsx'
import { stateLabel, useLanderQueue, useWorkspaces } from './data.tsx'
import type { WorkspaceConversation } from './data.tsx'
import { DiskAction, InfoAction, StatsAction } from './refs.ts'

const heading = 'mb-1 font-mono text-[10.5px] text-muted-foreground/70'

/** One line for a collapsed section header: what lands now, else the shown conversation's checkout state. */
export function useWorkspacesMeta() {
  const queue = useLanderQueue()
  const shown = useShown()
  if (queue.length) return `${queue.length} landing`
  return shown?.workspace ? stateLabel(shown.workspace).toLowerCase() : 'shared checkout'
}

function useShown() {
  const summary = useConversationSummary(useConversation((conversation) => conversation.id))
  const workspace = useWorkspaces()[String(summary?.id)]
  return useMemo(() => summary && workspace && { ...summary, workspace }, [summary, workspace])
}

/**
 * Checkouts at a glance, for Info's Workspaces section: the lander's queue, the shown conversation's checkout, and
 * every checkout counted, with the disk they take.
 */
export function Workspaces() {
  const shown = useShown()
  return (
    <div className="flex flex-col gap-3" data-workspaces>
      <LanderQueue />
      {shown ? (
        <Checkout conversation={shown} key={shown.id} />
      ) : (
        <p className="font-mono text-[11px] text-muted-foreground/60">
          shown conversation works in the shared checkout
        </p>
      )}
      <Stats />
    </div>
  )
}

/** The shown conversation's checkout: path and branch to copy, target, commits ahead and the last landing. */
function Checkout({ conversation }: { conversation: WorkspaceConversation }) {
  const recorded = conversation.workspace!
  const info = useAction(
    InfoAction,
    { id: conversation.id },
    // A failure leaves the recorded workspace showing.
    { onError: () => undefined, on: [recorded.state, recorded.landed, conversation.busy] },
  )
  const queued = useLanderQueue().find((item) => item.conversationId === conversation.id)
  const workspace =
    info.data && info.data.state === recorded.state && info.data.landed === recorded.landed
      ? info.data
      : recorded
  const ahead = info.data?.ahead
  const home = useSystem()?.machine.home
  return (
    <div data-workspace={conversation.id}>
      <div className={cn(heading, 'flex items-center gap-1.5')}>
        <span>this checkout</span>
        <span
          className={cn(
            'text-muted-foreground',
            recorded.state === 'failed' && 'text-error',
            queued && 'text-brand',
          )}
        >
          · {queued ? (queued.state === 'landing' ? 'landing…' : 'queued') : stateLabel(recorded)}
        </span>
        <button
          aria-label={`Refresh #${conversation.id}`}
          className="ml-auto cursor-pointer rounded-sm p-0.5 hover:text-foreground disabled:opacity-50"
          disabled={info.loading}
          onClick={() => void info.refetch()}
          type="button"
        >
          <RefreshCwIcon className={cn('size-3', info.loading && 'animate-spin')} />
        </button>
      </div>
      <Rows>
        <Row label="path">
          <Copyable
            value={workspace.path}
            shown={elidePath(shortenPath(workspace.path, { home }), 34)}
          />
        </Row>
        <Row label="branch">
          <Copyable value={workspace.branch} />
        </Row>
        <Row label="target">
          <span className="truncate">
            {workspace.target}
            <span className="text-muted-foreground/60"> in {workspace.source}</span>
          </span>
        </Row>
        {typeof ahead === 'number' && (
          <Row label="ahead">
            {ahead} commit{ahead === 1 ? '' : 's'}
          </Row>
        )}
        {workspace.landed && <Row label="landed">{workspace.landed.slice(0, 7)}</Row>}
      </Rows>
      {(workspace.state === 'failed' || info.error) && (
        <p
          className="mt-1.5 font-mono text-[11px] break-words whitespace-pre-wrap text-error"
          role="alert"
        >
          {workspace.state === 'failed' ? workspace.error : info.error?.message}
        </p>
      )}
    </div>
  )
}

/** A value that copies itself on click; `shown` is a shorter form to display. */
function Copyable({ value, shown = value }: { value: string; shown?: string }) {
  return (
    <button
      aria-label={`Copy ${value}`}
      className="group/copy flex min-w-0 items-center gap-1 text-left hover:text-foreground"
      onClick={() => void navigator.clipboard.writeText(value)}
      title={`${value}\nclick to copy`}
      type="button"
    >
      <span className="truncate">{shown}</span>
      <CopyIcon className="size-3 shrink-0 opacity-0 transition-opacity group-hover/copy:opacity-50" />
    </button>
  )
}

/** The lander's queue, oldest first: what each submission waits for or is doing now. */
function LanderQueue() {
  const queue = useLanderQueue()
  if (!queue.length) return null
  return (
    <section aria-label="Lander queue">
      <h3 className={heading}>lander queue</h3>
      <ol className="flex flex-col gap-0.5 font-mono text-[11.5px]">
        {queue.map((item) => (
          <li className="flex min-w-0 items-center gap-2" key={item.id}>
            <ConversationRef className="max-w-1/2" id={item.conversationId} />
            <span className="shrink-0 text-muted-foreground">{item.tip.slice(0, 7)}</span>
            <span
              className={cn(
                'min-w-0 flex-1 truncate',
                item.state === 'landing' ? 'text-brand' : 'text-muted-foreground',
              )}
            >
              {item.state === 'landing' ? (item.step ?? 'landing') : `queued for ${item.target}`}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

const parts = (entries: [number, string][]) =>
  entries
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`)
    .join(' · ') || 'none'

/** How many checkouts there are, what their commits are, and the disk they take. */
function Stats() {
  const records = useWorkspaces()
  const states = Object.entries(records)
    .map(([id, workspace]) => `${id}:${workspace.state}:${workspace.landed ?? ''}`)
    .join()
  const { data, error } = useAction(StatsAction, null, { on: states, focus: true })
  const disk = useAction(DiskAction, null, { focus: true })
  if (error) return <p className="font-mono text-[11px] text-error">{error.message}</p>
  if (!data) return null
  return (
    <section aria-label="Workspace statistics">
      <h3 className={heading}>all checkouts</h3>
      <Rows>
        <Row label="checkouts">
          <span className="truncate">
            {data.total - data.removed}
            {data.removed > 0 && (
              <span className="text-muted-foreground/70"> · {data.removed} removed</span>
            )}
          </span>
        </Row>
        <Row label="state">
          <span className="truncate">
            {parts([
              [data.ready, 'ready'],
              [data.preparing, 'setting up'],
              [data.failed, 'failed'],
            ])}
          </span>
        </Row>
        <Row label="commits">
          <span className="truncate">
            {parts([
              [data.landed, 'landed'],
              [data.ahead, 'ahead'],
              [data.fresh, 'none yet'],
            ])}
          </span>
        </Row>
        <Row label="uncommitted">{data.dirty}</Row>
        <Row label="disk">
          <span
            className="truncate"
            title="Each checkout's blocks added up; copy-on-write checkouts share many of them"
          >
            {disk.data ? (
              disk.data.bytes === null ? (
                'unknown'
              ) : (
                <>
                  {formatBytes(disk.data.bytes)}
                  {disk.data.real != null && (
                    <span
                      className="text-muted-foreground/60"
                      title="Blocks shared between checkouts counted once (btrfs)"
                    >
                      {' '}
                      · {formatBytes(disk.data.real)} real
                    </span>
                  )}
                </>
              )
            ) : (
              <span className="text-muted-foreground/70">measuring…</span>
            )}
          </span>
        </Row>
      </Rows>
    </section>
  )
}
