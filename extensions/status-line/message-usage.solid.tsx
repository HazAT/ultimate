/** @jsxImportSource @solidjs/web */
import type { JSX } from '@solidjs/web'
import { Show, createMemo } from 'solid-js'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
import { formatDuration, formatTokens, useModels, useTranscript } from '@/sdk/solid'
import type { EntryRecord } from '@/sdk'
import { promptTokens } from '../../lib/context-usage.ts'
import { responseAfter, turnOf } from './turns.ts'

const dollars = (cost: number) => `$${cost.toFixed(cost < 1 ? 3 : 2)}`

function useUsage(entry: () => EntryRecord) {
  const entries = useTranscript()
  const models = useModels()
  return createMemo(() => {
    const record = entry()
    const stored = record.model?.[0]
    const input = stored?.role === 'user'
    const message =
      stored?.role === 'assistant' ? stored : input ? responseAfter(entries(), record) : undefined
    if (!message) return undefined
    const used = promptTokens(message.usage)
    if (!used) return undefined
    const window = models()?.models.find(
      (model) => model.provider === message.provider && model.id === message.model,
    )?.contextWindow
    const context = window
      ? `${((used / window) * 100).toFixed(1)}% ctx`
      : `${formatTokens(used)} ctx`
    const contextTip = `${used.toLocaleString()}${window ? ` of ${window.toLocaleString()}` : ''} tokens`
    if (input) return { text: context, contextTip }

    const ended = message.stopReason !== 'toolUse'
    const turn = ended ? turnOf(entries(), record) : undefined
    const many = turn && turn.responses > 1 ? turn : undefined
    const duration =
      many && formatDuration(message.timestamp + (message.durationMs ?? 0) - many.started)
    const cost = many?.cost ?? message.usage.cost.total
    const text = [
      ended && message.model,
      context,
      many && `turn ${duration}`,
      cost > 0 && dollars(cost),
    ]
      .filter(Boolean)
      .join(' · ')
    return { text, contextTip, response: { message, used, many, duration } }
  })
}

type Usage = NonNullable<ReturnType<ReturnType<typeof useUsage>>>

function UsageTip(props: { usage: Usage }): JSX.Element {
  return (
    <Show
      when={props.usage.response}
      fallback={<>Sent into a context of {props.usage.contextTip}</>}
    >
      {(response) => {
        const message = () => response().message
        const thinking = () => message().thinkingLevel ?? message().providerThinkingLevel
        return (
          <div class="grid grid-cols-[auto_auto] gap-x-3">
            <span>Response</span>
            <span>
              ↑{formatTokens(response().used)} ↓{formatTokens(message().usage.output)} ·{' '}
              {dollars(message().usage.cost.total)}
              {message().durationMs ? ` · ${formatDuration(message().durationMs!)}` : ''}
            </span>
            <Show when={response().many}>
              {(turn) => (
                <>
                  <span>Turn</span>
                  <span>
                    {turn().responses} responses · ↑{formatTokens(turn().prompt)} ↓
                    {formatTokens(turn().output)} · {dollars(turn().cost)} · {response().duration}
                  </span>
                </>
              )}
            </Show>
            <span>Context</span>
            <span>{props.usage.contextTip}</span>
            <span>Model</span>
            <span>
              {message().provider}/{message().model}
              {thinking() && ` · ${thinking()}`}
            </span>
          </div>
        )
      }}
    </Show>
  )
}

export function MessageUsage(props: { entry: EntryRecord }) {
  const usage = useUsage(() => props.entry)
  return (
    <Show when={usage()}>
      {(current) => (
        <Tooltip>
          <TooltipTrigger
            aria-label={`Usage for message #${props.entry.id}`}
            class="flex min-w-0 items-center gap-1.5"
            render={(trigger) => <span {...trigger} />}
          >
            <span class={current().response ? 'truncate' : undefined}>{current().text}</span>
          </TooltipTrigger>
          <TooltipContent class="font-mono text-[11px]" side="top">
            <UsageTip usage={current()} />
          </TooltipContent>
        </Tooltip>
      )}
    </Show>
  )
}
