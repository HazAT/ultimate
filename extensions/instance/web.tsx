import { ChevronRightIcon, ExternalLinkIcon } from 'lucide-react'
import { useEffect, useSyncExternalStore } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { Shimmer } from '@/components/ai/shimmer'
import { Tool, ToolContent, ToolHeader, ToolOutput, ToolSection } from '@/components/ai/tool'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  cn,
  defineWebExtension,
  ProjectChip,
  shortenPath,
  useAction,
  useConversations,
  useStore,
  useSystem,
  useToolDuration,
} from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { at, label } from './links.ts'
import { ListAction } from './refs.ts'
import type { Preview } from './refs.ts'

interface Instance {
  id: string
  url: string
  home: string
  pid: number
}

function result(output: string): unknown {
  try {
    return JSON.parse(output)
  } catch {
    return undefined
  }
}

/** One instance: its URL as a preview link, pid, home, and id. */
function Card({ instance, status }: { instance: Instance; status: string }) {
  const system = useSystem()
  const target = usePreviewTarget(instance.url, true)
  return (
    <div className="flex flex-col gap-0.5 rounded-sm border border-border/70 bg-terminal px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            target?.kind === 'off' ? 'bg-muted-foreground/50' : 'bg-success',
          )}
        />
        {target?.kind === 'off' ? (
          <span className="text-muted-foreground" title={target.reason}>
            {instance.url}
          </span>
        ) : (
          <a
            className="flex items-center gap-1 text-brand hover:underline"
            href={target?.href ?? instance.url}
            onClick={target?.open}
            rel="noreferrer"
            target={target?.kind === 'tailnet' ? '_blank' : undefined}
          >
            {target?.kind === 'tailnet'
              ? label(instance.url, instance.url, target.href)
              : instance.url}
            {target?.kind === 'tailnet' && <ExternalLinkIcon className="size-3" />}
          </a>
        )}
        <span className="text-muted-foreground">
          {target?.kind === 'off' ? target.reason.toLowerCase() : status}
        </span>
        <span className="ml-auto text-[0.6875rem] text-muted-foreground">pid {instance.pid}</span>
      </div>
      <div className="flex gap-3 text-[0.6875rem] text-muted-foreground">
        <span className="truncate" title={instance.home}>
          home {shortenPath(instance.home, { home: system?.machine.home })}
        </span>
        <span className="ml-auto shrink-0" title={instance.id}>
          {instance.id.slice(0, 8)}
        </span>
      </div>
    </div>
  )
}

function InstanceCall({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const action = typeof call.args.action === 'string' ? call.args.action : 'start'
  const id = typeof call.args.id === 'string' ? call.args.id : undefined
  const done = call.status === 'done'
  const value = done ? result(call.output) : undefined
  const started =
    action === 'start' && value && typeof value === 'object' && 'url' in value
      ? (value as Instance)
      : undefined
  const title =
    action === 'start'
      ? `start${started ? ` · ${started.url}` : ''}`
      : `${action}${id ? ` ${id.slice(0, 8)}` : ''}`
  return (
    <Tool defaultOpen={action !== 'logs' || call.status === 'error'}>
      <ToolHeader meta={duration} name="instance" state={call.status} title={title} />
      <ToolContent>
        {call.status === 'running' && (
          <ToolSection>
            <Shimmer className="text-[0.75rem]">
              {action === 'start' ? 'booting a second Ultimate…' : `${action}…`}
            </Shimmer>
          </ToolSection>
        )}
        {call.status === 'error' && <ToolOutput isError output={call.output} />}
        {started && (
          <ToolSection>
            <Card instance={started} status="started" />
          </ToolSection>
        )}
        {done && action === 'list' && Array.isArray(value) && (
          <ToolSection label={`${value.length} running`}>
            <div className="flex flex-col gap-1.5">
              {(value as Instance[]).map((instance) => (
                <Card instance={instance} key={instance.id} status="running" />
              ))}
            </div>
          </ToolSection>
        )}
        {done && action === 'stop' && (
          <ToolSection className="text-muted-foreground">stopped</ToolSection>
        )}
        {done && action === 'logs' && typeof value === 'string' && (
          <Collapsible className="group/logs" defaultOpen>
            <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-2.5 py-1.5 section-label hover:text-foreground">
              <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/logs:rotate-90" />
              Logs
              <span className="text-muted-foreground">{value.split('\n').length} lines</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="max-h-80 overflow-auto bg-terminal px-3 py-2 leading-[1.55] whitespace-pre-wrap text-foreground/85">
                {value}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
      </ToolContent>
    </Tool>
  )
}

/** What the `list` action returns. */
const isLoopback = (hostname: string) =>
  /^(127\.0\.0\.1|localhost|\[::1\])$|\.localhost$/.test(hostname)
/** Previews bind to loopback, so a page opened from elsewhere, such as the tailnet, cannot frame them. */
const loopback = isLoopback(location.hostname)

/**
 * In memory: the previews `list` returned last, which `Poll` asks for, and the preview shown below the title bar at
 * a URL of it. A reload returns to this project.
 */
let previews: Preview[] | undefined
let shown: { preview: Preview; url: string } | undefined
let refetch = () => {}
const listeners = new Set<() => void>()
const changed = () => {
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
function show(preview: Preview | undefined, url = preview?.url) {
  shown = preview && url ? { preview, url } : undefined
  changed()
}
const useShown = () => useSyncExternalStore(subscribe, () => shown)
const usePreviews = () => useSyncExternalStore(subscribe, () => previews)

/** Asks for the previews every 5 s, for the switcher and preview links; showing one that stopped returns. */
function Poll() {
  const { data, refetch: again } = useAction(ListAction, null, {
    // A failed poll leaves the last list; the next one tries again.
    onError: () => {},
  })
  useEffect(() => {
    refetch = () => void again()
    const timer = setInterval(refetch, 5000)
    return () => clearInterval(timer)
  }, [again])
  useEffect(() => {
    if (!data) return
    previews = data
    if (shown && !data.some((preview) => preview.running && preview.id === shown?.preview.id))
      shown = undefined
    changed()
  }, [data])
  return null
}

/**
 * What a link to `href` does. `self`: this server, opened in place. `frame`: a running preview, shown below the title
 * bar. `tailnet`: a running preview opened from elsewhere, at its tailnet address in a new tab, since such a page has
 * no switcher to return from the frame. `off`: a preview that no longer runs, or one not reachable from here.
 * Undefined for other links, including loopback ports this server never ran a preview on, which stay as they are;
 * `own` says `href` is a preview's own URL, which is then `off` when unknown.
 */
type Target =
  | { kind: 'self' | 'tailnet'; href: string; open?: undefined }
  | { kind: 'frame'; href: string; open: (event: MouseEvent) => void }
  | { kind: 'off'; reason: string; href?: undefined; open?: undefined }
function usePreviewTarget(href: string, own = false): Target | undefined {
  const list = usePreviews()
  const system = useSystem()
  const url = URL.parse(href)
  if (!url || !/^https?:$/.test(url.protocol) || !isLoopback(url.hostname) || !url.port)
    return undefined
  if (system && url.port === new URL(system.process.url).port)
    return { kind: 'self', href: at(location.origin, url) }
  const known = list?.filter((item) => new URL(item.url).port === url.port) ?? []
  const live = known.find((item) => item.running)
  if (!live) return known.length || own ? { kind: 'off', reason: 'Not running' } : undefined
  if (!loopback)
    return live.tailnet
      ? { kind: 'tailnet', href: at(live.tailnet, url) }
      : { kind: 'off', reason: 'Only on this machine' }
  const frame = at(live.url, url)
  return {
    kind: 'frame',
    href: frame,
    open: (event) => {
      event.preventDefault()
      show(live, frame)
    },
  }
}

/** A link to a preview as a chip with a live dot; links to this server open in place, other links stay as they are. */
function PreviewLink({
  href,
  children,
  core,
}: {
  href: string
  children: ReactNode
  core: ReactNode
}) {
  const target = usePreviewTarget(href)
  if (!target) return core
  if (target.kind === 'self') return <a href={target.href}>{children}</a>
  const chip =
    'inline-flex max-w-full items-center gap-1.5 rounded-sm bg-muted/60 px-1.5 align-baseline font-mono text-[0.7188rem] leading-5 wrap-anywhere'
  if (target.kind === 'off')
    return (
      <span
        className={cn(chip, 'text-muted-foreground')}
        data-preview-link="off"
        title={target.reason}
      >
        <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
        {children}
      </span>
    )
  // A button, not a link: the transcript's link styles would win over the chip's.
  return (
    <button
      className={cn(chip, 'text-left text-foreground transition-colors hover:bg-accent')}
      data-preview-link={target.kind}
      onClick={target.open ?? (() => window.open(target.href, '_blank', 'noreferrer'))}
      title={target.kind === 'tailnet' ? `Open ${target.href}` : 'Show preview'}
      type="button"
    >
      <span className="size-1.5 shrink-0 rounded-full bg-brand" />
      {target.kind === 'tailnet' && typeof children === 'string'
        ? label(children, href, target.href)
        : children}
    </button>
  )
}

const port = (url: string) => `:${new URL(url).port}`

/**
 * The title bar's project chip with the previews `instance` runs as its menu: "This project" and each preview. A plain
 * chip while there are none; the list refreshes when the menu opens.
 */
function Switcher() {
  const current = useShown()?.preview
  const data = usePreviews()?.filter((preview) => preview.running)
  const conversations = useConversations()
  if (!data?.length) return <ProjectChip />
  const title = (preview: Preview) =>
    conversations.find((conversation) => conversation.id === preview.conversationId)?.title
  return (
    <DropdownMenu modal={false} onOpenChange={(open) => open && refetch()}>
      <DropdownMenuTrigger asChild>
        <ProjectChip className={cn(current && 'bg-brand/10')} menu>
          {current ? (
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-[0.7188rem] text-muted-foreground">
              <span className="size-1.5 rounded-full bg-brand" />#{current.conversationId} ·{' '}
              {port(current.url)}
            </span>
          ) : (
            <span className="shrink-0 font-mono text-[0.7188rem] text-muted-foreground max-md:hidden">
              {data.length} {data.length === 1 ? 'preview' : 'previews'}
            </span>
          )}
        </ProjectChip>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80" sideOffset={4}>
        <DropdownMenuLabel className="px-2 pt-1 pb-1.5 section-label">Instances</DropdownMenuLabel>
        <DropdownMenuItem className="gap-2 py-1.5" onSelect={() => show(undefined)}>
          <span className={cn('flex-1 text-[0.8125rem]', !current && 'text-brand')}>
            This project
          </span>
          <span className="font-mono text-[0.6875rem] text-muted-foreground">
            {port(location.href)}
          </span>
        </DropdownMenuItem>
        {data.map((preview) => (
          <DropdownMenuItem
            className="gap-2 py-1.5"
            data-instance={preview.id}
            key={preview.id}
            onSelect={() => show(preview)}
          >
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[0.8125rem]',
                current?.id === preview.id && 'text-brand',
              )}
            >
              #{preview.conversationId}
              {title(preview) && <span className="text-muted-foreground"> {title(preview)}</span>}
            </span>
            <span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground">
              {port(preview.url)}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The shown preview's whole UI, below the title bar and above the surfaces. Showing another surface of this project
 * returns to it.
 */
function Embedded() {
  const current = useShown()
  const surface = useStore((state) => state.ui.surface?.id)
  useEffect(() => () => show(undefined), [surface])
  if (!current) return null
  const { preview, url } = current
  return (
    <div className="fixed inset-x-0 top-9 bottom-0 z-40 bg-background">
      {/* oxlint-disable-next-line react/iframe-missing-sandbox -- a whole Ultimate on its own origin, trusted as in its own tab */}
      <iframe
        allow="clipboard-read; clipboard-write"
        className="size-full border-0"
        key={preview.id}
        src={url}
        title={`Preview #${preview.conversationId}`}
      />
    </div>
  )
}

export default defineWebExtension({
  tools: { instance: InstanceCall },
  link: PreviewLink,
  slots: { 'titlebar.project': loopback ? [Switcher] : [], overlay: [Poll, Embedded] },
})
