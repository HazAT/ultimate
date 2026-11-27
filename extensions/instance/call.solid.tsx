import { ChevronRight, ExternalLink } from '@lucide/solid'
import { createMemo, For, Show } from 'solid-js'
import { Shimmer } from '@/components/ai/shimmer.solid.tsx'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import { useToolDuration, cn, shortenPath, useSystem, type SolidToolProps } from '@/sdk/solid'
import { usePreviewTarget } from './link.solid.tsx'
import { label } from './links.web.ts'

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

function Card(props: { instance: Instance; status: string; call: string }) {
  const system = useSystem()
  const target = usePreviewTarget(() => props.instance.url, true)
  const frame = () => {
    const link = target()
    return link?.kind === 'frame' ? link.open : undefined
  }
  const offline = () => {
    const link = target()
    return link?.kind === 'off' ? link.reason : undefined
  }
  const urlLabel = () => {
    const link = target()
    const url = props.instance.url
    return link?.kind === 'tailnet' ? label(url, url, link.href) : url
  }
  return (
    <div class="flex flex-col gap-0.5 rounded-sm border border-border/70 bg-terminal px-2.5 py-1.5">
      <div class="flex items-center gap-2">
        <span
          class={cn(
            'size-1.5 shrink-0 rounded-full',
            offline() ? 'bg-muted-foreground/50' : 'bg-success',
          )}
        />
        <Show
          when={offline()}
          fallback={
            <Show
              when={frame()}
              fallback={
                <a
                  class="flex items-center gap-1 text-brand hover:underline"
                  href={target()?.href ?? props.instance.url}
                  rel="noreferrer"
                  target={target()?.kind === 'tailnet' ? '_blank' : undefined}
                >
                  {urlLabel()}
                  <Show when={target()?.kind === 'tailnet'}>
                    <ExternalLink aria-hidden="true" class="size-3" />
                  </Show>
                </a>
              }
            >
              {(open) => (
                <Button
                  aria-label={`Show preview ${props.instance.url} (call ${props.call.slice(-8)})`}
                  class="h-auto p-0 font-mono text-[12px] font-normal text-brand hover:underline"
                  onClick={(event) => open()(event)}
                  size={null}
                  variant={null}
                >
                  {urlLabel()}
                </Button>
              )}
            </Show>
          }
        >
          {(reason) => (
            <span class="text-muted-foreground" title={reason()}>
              {props.instance.url}
            </span>
          )}
        </Show>
        <span class="text-muted-foreground/70">{offline()?.toLowerCase() ?? props.status}</span>
        <span class="ml-auto text-[11px] text-muted-foreground/70">pid {props.instance.pid}</span>
      </div>
      <div class="flex gap-3 text-[11px] text-muted-foreground/70">
        <span class="truncate" title={props.instance.home}>
          home {shortenPath(props.instance.home, { home: system()?.machine.home })}
        </span>
        <span class="ml-auto shrink-0" title={props.instance.id}>
          {props.instance.id.slice(0, 8)}
        </span>
      </div>
    </div>
  )
}

function Logs(props: { text: string; id: string }) {
  return (
    <Collapsible class="group/logs" defaultOpen>
      <CollapsibleTrigger
        aria-label={`Logs #${props.id}`}
        class="flex w-full items-center gap-1.5 px-2.5 py-1.5 section-label hover:text-foreground"
      >
        <ChevronRight
          aria-hidden="true"
          class="size-3 transition-transform group-data-open/logs:rotate-90"
        />
        Logs
        <span class="text-muted-foreground/60">{props.text.split('\n').length} lines</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre class="max-h-80 overflow-auto bg-terminal px-3 py-2 leading-[1.55] whitespace-pre-wrap text-foreground/85">
          {props.text}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function InstanceCall(props: SolidToolProps) {
  const duration = useToolDuration(() => props.call)
  const action = () =>
    typeof props.call.args.action === 'string' ? props.call.args.action : 'start'
  const id = () => (typeof props.call.args.id === 'string' ? props.call.args.id : undefined)
  const done = () => props.call.status === 'done'
  const failed = () => props.call.status === 'error'
  const value = createMemo(() => (done() ? result(props.call.output) : undefined))
  const started = () => {
    const instance = value()
    return action() === 'start' && instance && typeof instance === 'object' && 'url' in instance
      ? (instance as Instance)
      : undefined
  }
  const running = () => {
    const instances = value()
    return action() === 'list' && Array.isArray(instances) ? (instances as Instance[]) : undefined
  }
  const logs = () => {
    const output = value()
    return action() === 'logs' && typeof output === 'string' ? output : undefined
  }
  const title = () => {
    const instance = started()
    return action() === 'start'
      ? `start${instance ? ` · ${instance.url}` : ''}`
      : `${action()}${id() ? ` ${id()?.slice(0, 8)}` : ''}`
  }
  return (
    <Tool defaultOpen={action() !== 'logs' || failed()}>
      <ToolHeader
        aria-label={`Instance #${props.call.id}: ${title()}`}
        meta={duration()}
        name="instance"
        state={props.call.status}
        title={title()}
      />
      <ToolContent>
        <Show when={props.call.status === 'running'}>
          <ToolSection>
            <Shimmer class="text-[12px]">
              {action() === 'start' ? 'booting a second Ultimate…' : `${action()}…`}
            </Shimmer>
          </ToolSection>
        </Show>
        <Show when={failed()}>
          <ToolOutput isError output={props.call.output} />
        </Show>
        <Show when={started()}>
          {(instance) => (
            <ToolSection>
              <Card call={props.call.id} instance={instance()} status="started" />
            </ToolSection>
          )}
        </Show>
        <Show when={running()}>
          {(instances) => (
            <ToolSection label={`${instances().length} running`}>
              <div class="flex flex-col gap-1.5">
                <For each={instances()} keyed={(instance) => instance.id}>
                  {(instance) => (
                    <Card call={props.call.id} instance={instance()} status="running" />
                  )}
                </For>
              </div>
            </ToolSection>
          )}
        </Show>
        <Show when={done() && action() === 'stop'}>
          <ToolSection class="text-muted-foreground">stopped</ToolSection>
        </Show>
        <Show when={logs() !== undefined}>
          <Logs id={props.call.id} text={logs() ?? ''} />
        </Show>
      </ToolContent>
    </Tool>
  )
}
