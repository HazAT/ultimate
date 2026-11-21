/** @jsxImportSource @solidjs/web */
import { Flag } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { For, Show, createMemo } from 'solid-js'
import { Tool, ToolContent, ToolHeader, ToolSection } from '@/components/ai/tool.solid.tsx'
import { useToolDuration, type ToolCallView } from '@/sdk/solid'
import { ProposedGoal } from './propose.solid.tsx'

const words = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const prose = 'font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/90'

function headline(args: ToolCallView['args']): [string, string?] {
  const n = typeof args.n === 'number' ? args.n : ''
  const count = Array.isArray(args.criteria) ? args.criteria.length : 0
  switch (words(args.action)) {
    case 'criteria':
      return ['Set criteria', count ? `${count} to meet` : undefined]
    case 'decide':
      return ['Decided', [words(args.question), words(args.picked)].filter(Boolean).join(' → ')]
    case 'met':
      return [`Criterion ${n} met`]
    case 'failed':
      return [`Criterion ${n} not met yet`]
    case 'finish':
      return ['Goal finished', words(args.outcome)]
    case 'pause':
      return ['Waiting on you', words(args.reason)]
    case 'resume':
      return ['Back on the goal']
    default:
      return ['Goal']
  }
}

export function GoalCall(props: { call: ToolCallView; core: JSX.Element }) {
  return (
    <Show
      when={props.call.status !== 'error' && props.call.status !== 'interrupted'}
      fallback={props.core}
    >
      <Show
        when={props.call.args.action !== 'propose'}
        fallback={<ProposedGoal call={props.call} />}
      >
        <GoalTool call={props.call} />
      </Show>
    </Show>
  )
}

function GoalTool(props: { call: ToolCallView }) {
  const duration = useToolDuration(() => props.call)
  const args = () => props.call.args
  const title = createMemo(() => headline(args()))
  const criteria = createMemo(() =>
    Array.isArray(args().criteria) ? (args().criteria as unknown[]).map(words) : [],
  )
  const reason = () => words(args().reason)
  const summary = () => words(args().summary)
  const paused = () => args().action === 'pause'
  return (
    <Tool>
      <ToolHeader
        aria-label={`Goal tool call #${props.call.id}`}
        icon={Flag}
        meta={duration()}
        name=""
        state={props.call.status}
        title={
          <>
            <span class="text-foreground">{title()[0]}</span>
            <Show when={title()[1]}>
              <span> · {title()[1]}</span>
            </Show>
          </>
        }
      />
      <ToolContent>
        <Show when={criteria().length}>
          <ToolSection label="Done means">
            <ol class={`list-decimal space-y-0.5 pl-5 ${prose}`}>
              <For each={criteria()} keyed={false}>
                {(item) => <li>{item()}</li>}
              </For>
            </ol>
          </ToolSection>
        </Show>
        <Show when={reason() && !paused()}>
          <ToolSection label="Why">
            <p class={prose}>{reason()}</p>
          </ToolSection>
        </Show>
        <Show when={summary() || paused() || args().action === 'failed'}>
          <ToolSection label={summary() ? 'Summary' : undefined}>
            <p class={prose}>{summary() || reason() || props.call.output}</p>
          </ToolSection>
        </Show>
      </ToolContent>
    </Tool>
  )
}
