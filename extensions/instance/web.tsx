import { ChevronRightIcon, ExternalLinkIcon } from 'lucide-react'
import { useEffect, useSyncExternalStore } from 'react'
import { Shimmer } from '@/components/ai/shimmer'
import { Tool, ToolContent, ToolHeader, ToolOutput, ToolSection } from '@/components/ai/tool'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  cn,
  defineWebExtension,
  island,
  keepLast,
  provide,
  shortenPath,
  useAction,
  useStore,
  useSystem,
  useToolDuration,
} from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { PreviewUp } from '../sidebar/ui.tsx'
import { PreviewLink, previewTarget } from './link.solid.tsx'
import { label } from './links.ts'
import {
  canFrameLoopbackPreviews,
  getPreviews,
  getShown,
  polled,
  show,
  subscribe,
} from './previews.ts'
import { ListAction } from './refs.ts'
import { Switcher } from './switcher.solid.tsx'

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

function Card({ instance, status }: { instance: Instance; status: string }) {
  const system = useSystem()
  const target = previewTarget(instance.url, usePreviews(), system?.process.url, true)
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
        <span className="text-muted-foreground/70">
          {target?.kind === 'off' ? target.reason.toLowerCase() : status}
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground/70">pid {instance.pid}</span>
      </div>
      <div className="flex gap-3 text-[11px] text-muted-foreground/70">
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
            <Shimmer className="text-[12px]">
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
              <span className="text-muted-foreground/60">{value.split('\n').length} lines</span>
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

const useShown = () => useSyncExternalStore(subscribe, getShown)
const usePreviews = () => useSyncExternalStore(subscribe, getPreviews)

function Poll() {
  const { data, refetch: again } = useAction(ListAction, null, {
    onError: keepLast,
    every: 5000,
  })
  useEffect(() => {
    if (data) polled(data, () => void again())
  }, [data, again])
  return null
}

function Embedded() {
  const current = useShown()
  const surface = useStore((state) => state.ui.surface?.id)
  useEffect(() => () => show(undefined), [surface])
  if (!current) return null
  const { preview, url } = current
  return (
    <div className="fixed inset-x-0 top-9 bottom-0 z-40 bg-background">
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
  provides: [
    provide(PreviewUp, (id) =>
      (usePreviews() ?? []).some((preview) => preview.running && preview.conversationId === id),
    ),
  ],
  tools: { instance: InstanceCall },
  link: PreviewLink,
  slots: {
    'titlebar.left': canFrameLoopbackPreviews ? [island(Switcher)] : [],
    overlay: [Poll, Embedded],
  },
})
