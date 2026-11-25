import { Check, Clapperboard } from '@lucide/solid'
import { cn } from 'cn'
import { createMemo, For, Show, untrack } from 'solid-js'
import { Shimmer } from '@/components/ai/shimmer.solid.tsx'
import { Tool, ToolContent, ToolHeader, ToolSection } from '@/components/ai/tool.solid.tsx'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import {
  formatTokens,
  keepLast,
  ROOT,
  useAction,
  useDocOf,
  useToolDuration,
  type SolidToolProps,
} from '@/sdk/solid'
import { ThumbnailAction, VideosDoc } from './refs.ts'
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
  const ours = () => {
    const stage = (props.call.details as AskDetails | undefined)?.stage
    return props.call.status === 'done' ? stage === 'answered' : props.call.status === 'running'
  }
  return (
    <Show when={ours()} fallback={props.core}>
      <AskCard call={props.call} />
    </Show>
  )
}

function AskCard(props: { call: SolidToolProps['call'] }) {
  const duration = useToolDuration(() => props.call)
  const videos = useDocOf(() => ROOT, VideosDoc)
  const video = () => videos()?.videos[words(props.call.args.id)]
  const details = () => props.call.details as AskDetails | undefined
  const answered = () => {
    const value = details()
    return value?.stage === 'answered' ? value : undefined
  }
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
  const name = () => details()?.name ?? video()?.name ?? words(props.call.args.id)
  const length = () => details()?.seconds ?? video()?.seconds
  const thumbnail = useAction(
    ThumbnailAction,
    { id: untrack(() => words(props.call.args.id)) },
    { conversation: ROOT, onError: keepLast, on: () => video()?.thumbnail },
  )
  const image = () => (video()?.thumbnail ? thumbnail.data() : undefined)
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
            <Show when={length()}>{(value) => <span> · {seconds(value())}</span>}</Show>
            <Show when={range(props.call.args)}>{(part) => <span> · {part()}</span>}</Show>
          </>
        }
      />
      <ToolContent>
        <ToolSection class="flex gap-3">
          <div
            aria-hidden="true"
            class="relative flex h-12 w-20 shrink-0 flex-col items-center justify-center gap-0.5 overflow-hidden rounded-sm border border-border/70 bg-terminal text-muted-foreground"
          >
            <Show
              when={image()}
              fallback={
                <>
                  <Clapperboard class="size-4" stroke-width={1.5} />
                  <Show when={length()}>
                    {(value) => <span class="text-[10px] tabular-nums">{seconds(value())}</span>}
                  </Show>
                </>
              }
            >
              {(src) => (
                <>
                  <img
                    alt=""
                    class="absolute inset-0 size-full object-cover"
                    data-video-thumbnail
                    decoding="async"
                    src={src()}
                  />
                  <Show when={length()}>
                    {(value) => (
                      <span class="absolute right-0.5 bottom-0.5 rounded-sm bg-black/60 px-1 text-[10px] text-white tabular-nums">
                        {seconds(value())}
                      </span>
                    )}
                  </Show>
                </>
              )}
            </Show>
          </div>
          <div class="min-w-0 flex-1 space-y-1.5">
            <p class="font-sans text-[13px] leading-snug text-foreground/90">
              {words(props.call.args.question)}
            </p>
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
                            step() >= item().at ? 'text-foreground/80' : 'text-muted-foreground/50',
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
          </div>
        </ToolSection>
        <Show when={answered()}>
          {(done) => (
            <ToolSection class="border-t border-border/60">
              <Markdown class="font-sans text-[13px] leading-relaxed" text={done().answer} />
              <div class="pt-1 text-[11px] text-muted-foreground/70">
                {usage()} · sent to Google (Gemini API)
              </div>
            </ToolSection>
          )}
        </Show>
      </ToolContent>
    </Tool>
  )
}
