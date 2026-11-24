import { Check, Clapperboard } from '@lucide/solid'
import { cn } from 'cn'
import { createMemo, For, Show } from 'solid-js'
import { Shimmer } from '@/components/ai/shimmer.solid.tsx'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool.solid.tsx'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import { formatTokens, ROOT, useDocOf, useToolDuration, type SolidToolProps } from '@/sdk/solid'
import { VideosDoc } from './refs.ts'
import type { AskDetails } from './refs.ts'

const words = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const seconds = (value: number) => `${Math.round(value)} s`

function range(args: SolidToolProps['call']['args']) {
  const from = typeof args.from === 'number' ? args.from : undefined
  const to = typeof args.to === 'number' ? args.to : undefined
  return from === undefined && to === undefined
    ? undefined
    : `${seconds(from ?? 0)}–${to === undefined ? 'end' : seconds(to)}`
}

export function VideoAskCall(props: SolidToolProps) {
  const duration = useToolDuration(() => props.call)
  const videos = useDocOf(() => ROOT, VideosDoc)
  const video = () => videos()?.videos[words(props.call.args.id)]
  const details = () => props.call.details as AskDetails | undefined
  const answered = () => {
    const value = details()
    return value?.stage === 'answered' ? value : undefined
  }
  const failed = () => props.call.status === 'error' || props.call.status === 'interrupted'
  const step = createMemo(() => {
    if (answered()) return 3
    if (details()?.stage === 'asking') return 2
    return props.call.status === 'running' ? 1 : 0
  })
  const asking = () => {
    const value = details()
    return value?.stage === 'asking' && value.parts > 1
      ? `asking Gemini · part ${value.part} of ${value.parts}`
      : 'asking Gemini'
  }
  const steps = () => [
    { at: 1, label: 'reading video' },
    { at: 2, label: asking() },
    { at: 3, label: 'answered' },
  ]
  const usage = () => {
    const done = answered()
    if (!done) return undefined
    const cached = done.usage.cachedContentTokenCount
    return [
      done.model,
      `${formatTokens(done.usage.promptTokenCount)} in${cached ? ` (${formatTokens(cached)} cached)` : ''}`,
      `${formatTokens(done.usage.candidatesTokenCount)} out`,
    ].join(' · ')
  }
  const name = () => video()?.name ?? words(props.call.args.id)
  return (
    <Tool defaultOpen>
      <ToolHeader
        aria-label={`Video question #${props.call.id}: ${name()}`}
        icon={Clapperboard}
        meta={duration()}
        name="video"
        state={props.call.status}
        title={
          <>
            <span class="text-foreground/90">{name()}</span>
            <Show when={video()?.seconds}>{(length) => <span> · {seconds(length())}</span>}</Show>
            <Show when={range(props.call.args)}>{(part) => <span> · {part()}</span>}</Show>
          </>
        }
      />
      <ToolContent>
        <ToolSection class="flex gap-3">
          <div
            aria-hidden="true"
            class="flex h-12 w-20 shrink-0 flex-col items-center justify-center gap-0.5 rounded-sm border border-border/70 bg-terminal text-muted-foreground"
          >
            <Clapperboard class="size-4" stroke-width={1.5} />
            <Show when={video()?.seconds}>
              {(length) => <span class="text-[10px] tabular-nums">{seconds(length())}</span>}
            </Show>
          </div>
          <div class="min-w-0 flex-1 space-y-1.5">
            <p class="font-sans text-[13px] leading-snug text-foreground/90">
              {words(props.call.args.question)}
            </p>
            <Show when={!failed()}>
              <ol
                aria-label={`Video question #${props.call.id} progress`}
                class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground"
              >
                <For each={steps()} keyed={false}>
                  {(item, index) => (
                    <li class="flex items-center gap-1.5">
                      <Show when={index > 0}>
                        <span class="text-muted-foreground/40">→</span>
                      </Show>
                      <Show
                        when={step() === item().at && step() < 3}
                        fallback={
                          <span
                            class={cn(
                              'flex items-center gap-1',
                              step() >= item().at
                                ? 'text-foreground/80'
                                : 'text-muted-foreground/50',
                            )}
                          >
                            <Show when={step() > item().at || step() === 3}>
                              <Check aria-hidden="true" class="size-3 text-success" />
                            </Show>
                            {item().label}
                          </span>
                        }
                      >
                        <Shimmer class="text-brand">{item().label}</Shimmer>
                      </Show>
                    </li>
                  )}
                </For>
              </ol>
            </Show>
          </div>
        </ToolSection>
        <Show when={answered()}>
          {(done) => (
            <ToolSection class="border-t border-border/60">
              <Markdown class="font-sans text-[13px] leading-relaxed" text={done().answer} />
              <div class="pt-1 text-[11px] text-muted-foreground/70">
                {usage()} · sent to Google (Antigravity)
              </div>
            </ToolSection>
          )}
        </Show>
        <Show when={failed()}>
          <ToolOutput class="border-t border-border/60" isError output={props.call.output} />
        </Show>
      </ToolContent>
    </Tool>
  )
}
