/** @jsxImportSource @solidjs/web */
import { CalendarClock, Radar, Timer, Zap } from '@lucide/solid'
import { Dynamic } from '@solidjs/web'
import { createMemo, Show } from 'solid-js'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  useToolDuration,
  api,
  openPanel,
  showSurface,
  switchConversation,
  type SolidToolProps,
} from '@/sdk/solid'
import { openAutomation, openAutomationsPanel } from './navigation.ts'

const shell = { openPanel, showSurface, switchConversation }
const words = (value: unknown) => (typeof value === 'string' ? value : '')

function TextSection(props: { label: string; text: string }) {
  return (
    <Show when={props.text}>
      <ToolSection label={props.label}>
        <p class="font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/90">
          {props.text}
        </p>
      </ToolSection>
    </Show>
  )
}

export function AutomationCall(props: SolidToolProps) {
  const duration = useToolDuration(() => props.call)
  const args = () => props.call.args
  const action = () => words(args().action) || '…'
  const id = createMemo(
    () => words(args().id) || (/^(A\d+|[a-z][a-z0-9-]*) .+ — /.exec(props.call.output)?.[1] ?? ''),
  )
  const name = () => words(args().name)
  const schedule = () => words(args().schedule)
  const ask = () => words(args().ask)
  const kind = () =>
    args().event || args().condition ? Zap : ask() ? Radar : schedule() ? CalendarClock : Timer
  const destination = () => (id() ? `Show ${id()} in Automations` : 'Show Automations')
  return (
    <Tool defaultOpen={props.call.status === 'error'}>
      <div class="flex items-center">
        <ToolHeader
          aria-label={`Toggle automation ${action()} call ${props.call.id}`}
          class="min-w-0 flex-1"
          meta={
            <>
              <Show when={schedule()}>
                <span class="max-w-48 truncate">{schedule()}</span>
              </Show>
              <Show when={ask()}>
                <span>{args().once === false ? 'watch' : 'watch once'}</span>
              </Show>
              <Show when={duration()}>
                <span>{duration()}</span>
              </Show>
            </>
          }
          name="automation"
          state={props.call.status}
          title={
            <>
              {action() === 'run' ? 'run now' : action()}
              <Show when={id()}>
                <span class="text-foreground/85"> {id()}</span>
              </Show>
              <Show when={name()}>
                <span class="text-foreground/85"> {name()}</span>
              </Show>
              {action() === 'abort' && words(args().runId) && ` run ${words(args().runId)}`}
              {words(args().to) && ` → ${words(args().to)}`}
            </>
          }
        />
        <Button
          aria-label={`${destination()} from call ${props.call.id}`}
          class="mr-1 h-6 shrink-0 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() =>
            id() ? openAutomation(id(), shell, api.action) : openAutomationsPanel(shell)
          }
          size="sm"
          title={destination()}
          variant="ghost"
        >
          <Dynamic component={kind()} class="size-3" />
          {id() || 'automations'}
        </Button>
      </div>
      <ToolContent>
        <TextSection label="Watch for" text={ask()} />
        <TextSection label="Prompt" text={words(args().prompt)} />
        <TextSection label="Reason" text={words(args().reason)} />
        <ToolOutput isError={props.call.status === 'error'} output={props.call.output} />
        <ToolDiagnostics diagnostics={props.call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}
