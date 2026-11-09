import { CableIcon, ChevronDownIcon } from 'lucide-react'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Conversation,
  Dock,
  cn,
  defineWebExtension,
  provide,
  formatBytes,
  formatDuration,
  formatTime,
  formatTokens,
  useAction,
  useConversation,
  useDialog,
  useExtensionUiState,
  useViewport,
} from '@/sdk'
import { RawResponse, Raw, ReadableRequest, ReadableResponse } from './body.tsx'
import { DiffView } from './diff-view.tsx'
import { useOpenWire, WireLink } from './link.tsx'
import { SystemTab } from '../system/ui.tsx'
import type { Picked } from './link.tsx'
import { CallAction, ListAction } from './refs.ts'
import type { WireSummary } from './refs.ts'

type Tab = 'request' | 'response' | 'diff'
type Mode = 'readable' | 'raw'

/** Cache read and write of a call, the numbers that say whether its prefix held. */
function CacheNumbers({ call }: { call: WireSummary }) {
  if (!call.usage) return null
  const { cacheRead, cacheWrite, input, output } = call.usage
  return (
    <span className="tabular-nums" title="cache read · cache write · input · output tokens">
      <span className="text-muted-foreground/60">R</span> {formatTokens(cacheRead)}{' '}
      <span className="text-muted-foreground/60">W</span>{' '}
      <span className={cn(cacheWrite > cacheRead && cacheWrite > 1000 && 'text-warning/90')}>
        {formatTokens(cacheWrite)}
      </span>{' '}
      <span className="text-muted-foreground/60">in</span> {formatTokens(input)}{' '}
      <span className="text-muted-foreground/60">↓</span>
      {formatTokens(output)}
    </span>
  )
}

const sizes = (call: WireSummary) =>
  `${formatBytes(call.requestBytes)}${call.responseBytes === undefined ? '' : ` → ${formatBytes(call.responseBytes)}`}`

function CallRow({
  call,
  selected,
  onPick,
}: {
  call: WireSummary
  selected: boolean
  onPick: () => void
}) {
  return (
    <button
      className={cn(
        'block w-full cursor-pointer border-l-2 border-transparent px-3 py-1.5 text-left font-mono text-[11px] hover:bg-accent/60',
        selected && 'border-brand bg-accent',
      )}
      data-selected={selected || undefined}
      onClick={onPick}
      type="button"
    >
      <span className="flex items-baseline gap-2">
        <span className="w-6 shrink-0 text-muted-foreground/70 tabular-nums">#{call.n}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/90">{call.model}</span>
        {call.failure ? (
          <span className="shrink-0 text-error">failed</span>
        ) : (
          <span className="shrink-0 text-muted-foreground/70 tabular-nums">
            {formatTime(call.startedAt, true)}
          </span>
        )}
      </span>
      <span className="flex items-baseline gap-2 pl-8 text-muted-foreground">
        <CacheNumbers call={call} />
        <span className="ml-auto shrink-0 text-muted-foreground/60">
          {formatBytes(call.requestBytes)}
        </span>
      </span>
    </button>
  )
}

/** A segmented switch: Request · Response · Diff, Readable · Raw. */
function Segments<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: [T, string][]
  onChange: (next: T) => void
  label: string
}) {
  return (
    <div
      aria-label={label}
      className="flex shrink-0 rounded-md border border-border/70 p-0.5"
      role="tablist"
    >
      {options.map(([key, title]) => (
        <button
          aria-selected={key === value}
          className={cn(
            'cursor-pointer rounded-[4px] px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground',
            key === value && 'bg-accent text-foreground',
          )}
          key={key}
          onClick={() => onChange(key)}
          role="tab"
          type="button"
        >
          {title}
        </button>
      ))}
    </div>
  )
}

/** The selected call: its line of facts, the tabs, and the tab's view. */
function Detail({ summary, calls }: { summary: WireSummary; calls: WireSummary[] }) {
  const call = useAction(CallAction, { n: summary.n })
  const [tab, setTab] = useExtensionUiState<Tab>('tab', 'request')
  const [mode, setMode] = useExtensionUiState<Mode>('mode', 'readable')
  const relay = summary.source === 'relay'
  let body: ReactNode
  if (tab === 'diff') body = <DiffView call={summary} calls={calls} />
  else if (!call.data)
    body = (
      <p className="text-muted-foreground/70">
        {call.loading || call.data === undefined
          ? 'loading…'
          : 'This call is no longer kept: Wire keeps the newest 20 per conversation.'}
      </p>
    )
  else if (tab === 'request')
    body = mode === 'raw' ? <Raw text={call.data.request} /> : <ReadableRequest call={call.data} />
  else
    body = mode === 'raw' ? <RawResponse call={call.data} /> : <ReadableResponse call={call.data} />
  return (
    <main className="min-w-0 flex-1 overflow-y-auto font-mono text-[11.5px]">
      <div className="sticky top-0 z-10 border-b border-border/70 bg-background/95 px-5 pt-3 pb-2.5 backdrop-blur">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className="text-[13px] text-foreground">#{summary.n}</span>
          <span className="text-foreground/90">{summary.model}</span>
          <span>· {summary.provider}</span>
          <span
            className="rounded-sm border border-border/70 px-1 text-[10.5px]"
            title={
              relay
                ? 'The HTTP exchange through Pi’s turn relay, byte for byte'
                : 'The body pi-ai built and the reply Pi assembled; no transport bytes or headers'
            }
          >
            {relay ? 'on the wire' : 'pi-ai payload'}
          </span>
          <span>
            · {formatTime(summary.startedAt, true)} ·{' '}
            {formatDuration(summary.endedAt - summary.startedAt)}
          </span>
          <span>· {sizes(summary)}</span>
          {summary.status !== undefined && summary.status !== 200 && (
            <span className="text-error">· HTTP {summary.status}</span>
          )}
        </div>
        {summary.transport && (
          <p className="mt-1 text-[11px] text-muted-foreground/80">{summary.transport}</p>
        )}
        <div className="mt-2.5 flex items-center gap-2">
          <Segments
            label="Part of the call"
            onChange={setTab}
            options={[
              ['request', 'Request'],
              ['response', 'Response'],
              ['diff', 'Diff'],
            ]}
            value={tab}
          />
          {tab !== 'diff' && (
            <Segments
              label="View"
              onChange={setMode}
              options={[
                ['readable', 'Readable'],
                ['raw', 'Raw'],
              ]}
              value={mode}
            />
          )}
        </div>
      </div>
      <div className="px-5 pt-4 pb-10">{body}</div>
    </main>
  )
}

/** The call list as a dropdown, on a phone. */
function CallMenu({
  calls,
  selected,
  onPick,
}: {
  calls: WireSummary[]
  selected?: WireSummary
  onPick: (n: number) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-8 w-full shrink-0 cursor-pointer items-center gap-1.5 border-b border-border/70 bg-sidebar px-3 font-mono text-[12px] text-muted-foreground">
        {selected ? `#${selected.n} · ${selected.model}` : `${calls.length} calls`}
        <ChevronDownIcon className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[60vh] w-[calc(100vw-1rem)] overflow-y-auto"
      >
        {calls.toReversed().map((call) => (
          <DropdownMenuItem
            className="gap-2 font-mono text-[12px]"
            key={call.n}
            onSelect={() => onPick(call.n)}
          >
            <span className="w-7 text-muted-foreground">#{call.n}</span>
            <span className="min-w-0 flex-1 truncate">{call.model}</span>
            <span className="text-muted-foreground">{formatTime(call.startedAt, true)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The shown conversation's kept calls on the left, the selected one in the middle, the agent docked on the right. */
function Wire() {
  const busy = useConversation((conversation) => conversation.busy)
  const conversationId = useConversation((conversation) => conversation.id)
  const list = useAction(ListAction, null, { on: busy, focus: true })
  const [picked, setPicked] = useExtensionUiState<Picked | null>('picked', null)
  const phone = useViewport() === 'phone'
  const calls = list.data ?? []
  // A pick belongs to the conversation it was made in; another conversation starts at its newest call.
  const own = picked?.conversation === conversationId ? picked : null
  const selected = own ? calls.find((call) => call.n === own.n) : calls.at(-1)
  const pick = (n: number) => {
    if (conversationId !== undefined) setPicked({ conversation: conversationId, n })
  }
  let main: ReactNode
  if (list.data === undefined)
    main = (
      <p className="flex-1 py-10 text-center font-mono text-[11.5px] text-muted-foreground/70">
        {list.error ? `Could not read the calls: ${list.error.message}` : 'loading…'}
      </p>
    )
  else if (calls.length === 0)
    main = (
      <div className="flex-1 px-6 py-12 text-center font-mono text-[11.5px] text-muted-foreground/70">
        <p>No calls kept for this conversation yet.</p>
        <p className="mt-1">Its next model call shows here, request and response as sent.</p>
      </div>
    )
  else
    main = (
      <>
        {!phone && (
          <nav className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-border/70 bg-sidebar">
            <div className="flex items-baseline gap-2 px-3 pt-2.5 pb-1.5">
              <span className="section-label">calls</span>
              <span className="font-mono text-[11px] text-muted-foreground/60">
                {calls.length} kept · newest first
              </span>
            </div>
            {calls.toReversed().map((call) => (
              <CallRow
                call={call}
                key={call.n}
                onPick={() => pick(call.n)}
                selected={call.n === selected?.n}
              />
            ))}
          </nav>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          {phone && <CallMenu calls={calls} onPick={pick} selected={selected} />}
          {selected ? (
            <Detail calls={calls} key={selected.n} summary={selected} />
          ) : (
            <p className="flex-1 px-6 py-12 text-center font-mono text-[11.5px] text-muted-foreground/70">
              That response is no longer kept: Wire keeps the newest {calls.length} calls of a
              conversation. Pick one on the left.
            </p>
          )}
        </div>
      </>
    )
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/70 px-3 font-mono text-[11px] text-muted-foreground">
          <CableIcon className="size-3.5" />
          <span className="truncate">
            #{conversationId} · what its model calls sent and got back
          </span>
        </div>
        <div className="flex min-h-0 flex-1">{main}</div>
      </div>
      <Dock>
        <Conversation variant="dock" />
      </Dock>
    </div>
  )
}

const openDialog = 'wire.open'

/** The ⌘K command opens this pseudo-dialog; selecting System's Wire tab needs a hook, so a component does it. */
function OpenOnCommand() {
  const [open, setOpen] = useDialog(openDialog)
  const openWire = useOpenWire()
  useEffect(() => {
    if (!open) return
    setOpen(false)
    openWire()
  }, [open, setOpen, openWire])
  return null
}

const tab = { id: 'wire', title: 'Wire', component: Wire }

export default defineWebExtension({
  provides: [provide(SystemTab, () => tab)],
  commands: [{ id: 'wire.open', title: 'Open Wire', run: (context) => context.open(openDialog) }],
  slots: { overlay: [OpenOnCommand] },
  entries: { 'pi.assistant': WireLink },
})
