/** @jsxImportSource @solidjs/web */
import { Match, Show, Switch } from 'solid-js'
import { Shimmer } from '@/components/ai/shimmer.solid.tsx'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool.solid.tsx'
import { useToolDuration } from '@/sdk/parts.solid.tsx'
import type { ToolCallView } from '@/sdk'

interface RestartDetails {
  fromGeneration?: number
  toGeneration?: number
  fromBuild?: string
  toBuild?: string
  refused?: boolean
  rolledBack?: boolean
  error?: string
}

function SwapTitle(props: { result: RestartDetails }) {
  const before = () => props.result.fromBuild
  const after = () => props.result.toBuild
  return (
    <>
      <span class="text-success">swapped</span> · gen
      {props.result.fromGeneration !== undefined ? ` ${props.result.fromGeneration}` : ''} →{' '}
      {props.result.toGeneration}
      <Show when={before() && after()}>
        <Show when={before() !== after()} fallback=" · same build">
          {' '}
          · build {before()?.slice(0, 7)} →{' '}
          <span class="text-foreground/85">{after()?.slice(0, 7)}</span>
        </Show>
      </Show>
    </>
  )
}

export function RestartCall(props: { call: ToolCallView }) {
  const duration = useToolDuration(() => props.call)
  const result = () => (props.call.details ?? {}) as RestartDetails
  const state = () => props.call.status
  const failed = () => state() === 'error'
  const error = () => result().error ?? (failed() ? props.call.output : undefined)
  return (
    <Tool defaultOpen={failed()}>
      <ToolHeader
        aria-label={`Restart tool call #${props.call.id}`}
        meta={duration()}
        name="restart"
        state={state()}
        title={
          <Switch fallback="core swap">
            <Match when={state() === 'done' && result().toGeneration !== undefined}>
              <SwapTitle result={result()} />
            </Match>
            <Match when={failed()}>
              <span class="text-error">
                {result().refused
                  ? 'restart refused · shared host unchanged'
                  : result().rolledBack
                    ? `activation failed · rolled back to gen ${result().toGeneration ?? result().fromGeneration ?? ''}`
                    : 'boot failed · the old core kept serving'}
              </span>
            </Match>
            <Match when={state() === 'running' || state() === 'pending'}>
              type-checking and booting a new core…
            </Match>
            <Match when={state() === 'interrupted'}>interrupted</Match>
          </Switch>
        }
      />
      <ToolContent>
        <Show when={state() === 'running'}>
          <ToolSection>
            <Shimmer class="text-[12px]">
              blue/green swap: type-check, boot, hand over storage, resume this run…
            </Shimmer>
          </ToolSection>
        </Show>
        <Show
          when={error()}
          fallback={
            <Show when={props.call.output}>
              <ToolSection class="text-muted-foreground">{props.call.output}</ToolSection>
            </Show>
          }
        >
          {(failure) => <ToolOutput isError output={failure()} />}
        </Show>
      </ToolContent>
    </Tool>
  )
}
