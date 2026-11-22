// Pi upstream: @earendil-works/pi-durable@1.6.0 src/tools/bash.ts — internal bash exit_code diagnostic message drives exitOf. Drop when Pi exports structured bash outcomes.
import { X } from '@lucide/solid'
import { createMemo, createSignal, For, Show } from 'solid-js'
import { AnsiOutput } from '@/components/ai/ansi-output.solid.tsx'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolSection,
} from '@/components/ai/tool.solid.tsx'
import { languageFromPath } from '@/components/markdown/highlight.ts'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  useToolDuration,
  api,
  useConversationId,
  type SolidToolProps,
  type ToolCallView,
} from '@/sdk/solid'
import { formatBashCommand } from './bash-command.ts'
import type { BashStep } from './bash-command.ts'
import { CodeBlock } from './code.solid.tsx'
import { Caret, text, useFollow, usePath } from './display.solid.tsx'
import { CancelAction } from './refs.ts'

function exitOf(call: ToolCallView): { label: string; ok: boolean } | undefined {
  if (call.status === 'done' && /\n\[Cancelled by the user after [^\]]*\]$/.test(call.output))
    return { label: 'cancelled', ok: false }
  if (call.status === 'done') return { label: 'exit 0', ok: true }
  if (call.status === 'interrupted') return { label: 'interrupted', ok: false }
  if (call.status !== 'error') return undefined
  const exited = call.diagnostics.find((diagnostic) => diagnostic.code === 'exit_code')
  const code = exited && /\d+/.exec(exited.message)?.[0]
  if (code) return { label: `exit ${code}`, ok: false }
  const messages = call.diagnostics.map((diagnostic) => diagnostic.message).join('\n')
  if (/timed out/.test(messages)) return { label: 'timeout', ok: false }
  if (/aborted/i.test(messages)) return { label: 'aborted', ok: false }
  return { label: 'failed', ok: false }
}

const separators: Record<string, string> = { '&&': '&&', '||': '||', ';': '·' }

const written = (step: BashStep) =>
  step.heredocs
    .find((heredoc) => heredoc.file && !heredoc.file.startsWith('heredoc.'))
    ?.file?.split('/')
    .at(-1)

function BashSummary(props: { steps: BashStep[] }) {
  const runs = createMemo(() => {
    const result: { step: BashStep; count: number }[] = []
    for (const step of props.steps) {
      const previous = result.at(-1)
      if (
        previous &&
        previous.step.programs.join() === step.programs.join() &&
        step.operator !== '||'
      )
        previous.count++
      else result.push({ step, count: 1 })
    }
    return result
  })
  return (
    <For each={runs()} keyed={false}>
      {(run, index) => (
        <span>
          <Show when={index > 0}>
            <span class="px-1.5 text-muted-foreground/50">
              {separators[run().step.operator ?? ';']}
            </span>
          </Show>
          <For each={run().step.programs}>
            {(name, position) => {
              const [program, ...rest] = name.split(' ')
              return (
                <span>
                  <Show when={position() > 0}>
                    <span class="px-1 text-brand/70">→</span>
                  </Show>
                  <span class="text-foreground/90">{program}</span>
                  <Show when={rest.length > 0}>
                    <span class="text-muted-foreground"> {rest.join(' ')}</span>
                  </Show>
                </span>
              )
            }}
          </For>
          <Show when={written(run().step)}>
            {(file) => <span class="text-muted-foreground"> &gt; {file()}</span>}
          </Show>
          <Show when={run().count > 1}>
            <span class="pl-1 text-muted-foreground/60">×{run().count}</span>
          </Show>
        </span>
      )}
    </For>
  )
}

function CancelCall(props: { callId: string }) {
  const conversationId = useConversationId()
  const [sent, setSent] = createSignal(false)
  return (
    <Button
      aria-label={`Cancel bash call ${props.callId}`}
      class="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 data-disabled:opacity-40 data-pending:opacity-40"
      disabled={sent()}
      onClick={() =>
        api
          .action(CancelAction, { callId: props.callId }, { conversationId: conversationId() })
          .then(() => {
            setSent(true)
          })
      }
      size={null}
      title="Cancel this command; the agent gets the output so far"
      type="button"
      variant={null}
    >
      <X class="size-3" />
    </Button>
  )
}

function useCommand(call: () => ToolCallView) {
  const command = createMemo(() => text(call().args.command))
  const display = createMemo(() => formatBashCommand(command()))
  const parsed = () => display().steps.some((step) => step.programs.length > 0)
  const firstLine = () => command().split('\n')[0]
  return { command, display, parsed, firstLine }
}

export function Bash(props: SolidToolProps) {
  const { command, display, parsed, firstLine } = useCommand(() => props.call)
  const directory = usePath(() => display().directory ?? '')
  const plain = () =>
    parsed() &&
    display().steps.length === 1 &&
    display().steps[0].programs.length === 1 &&
    !display().directory &&
    !command().includes('\n')
  const duration = useToolDuration(() => props.call)
  const exit = createMemo(() => {
    const status = exitOf(props.call)
    return status?.ok === false ? status.label : undefined
  })
  const output = () => props.call.output
  const running = () => props.call.status === 'running'
  const [toggled, setToggled] = createSignal<boolean>()
  const open = () => toggled() ?? (running() || props.call.status === 'error')
  const scroller = useFollow(() => running() && open(), output)
  return (
    <Tool onOpenChange={setToggled} open={open()}>
      <ToolHeader
        aria-label={`Bash call ${props.call.id}: ${firstLine()}`}
        meta={
          <>
            <Show when={display().directory}>
              <span class="max-w-48 truncate" title={display().directory}>
                {directory()}
              </span>
            </Show>
            <Show when={exit()}>
              {(label) => (
                <span class={label() === 'cancelled' ? 'text-warning' : 'text-error'}>
                  {label()}
                </span>
              )}
            </Show>
            <Show when={duration()}>
              <span>{duration()}</span>
            </Show>
          </>
        }
        action={running() ? <CancelCall callId={props.call.id} /> : undefined}
        name="$"
        state={props.call.status}
        title={
          <span title={firstLine()}>
            <Show
              when={parsed() && !plain()}
              fallback={<span class="text-foreground/90">{firstLine()}</span>}
            >
              <BashSummary steps={display().steps} />
            </Show>
          </span>
        }
      />
      <ToolContent>
        <Show when={!plain()}>
          <ToolSection class="space-y-1.5">
            <Show when={display().directory}>
              <div class="flex gap-2 text-muted-foreground/70">
                <span class="w-4 shrink-0 text-muted-foreground/50">$</span>
                <span class="min-w-0 truncate" title={display().directory}>
                  cd {directory()}
                </span>
              </div>
            </Show>
            <For each={display().steps} keyed={false}>
              {(step) => (
                <div class="flex gap-2">
                  <span class="w-4 shrink-0 pt-px text-muted-foreground/50">
                    {step().operator ?? (display().directory ? '&&' : '$')}
                  </span>
                  <div class="min-w-0 flex-1 space-y-1">
                    <CodeBlock
                      class="rounded-none border-none bg-transparent [&_pre]:p-0 [&_pre]:whitespace-pre-wrap [&_.whitespace-pre]:whitespace-pre-wrap"
                      code={step().text}
                      language="bash"
                    />
                    <For each={step().heredocs} keyed={false}>
                      {(heredoc) => (
                        <div class="border-l-2 border-border/80">
                          <CodeBlock
                            class="rounded-none border-none"
                            code={heredoc().body}
                            language={languageFromPath(heredoc().file ?? '')}
                          />
                          <pre class="px-3 text-muted-foreground/60">{heredoc().closing}</pre>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </ToolSection>
        </Show>
        <Show
          when={output() || running()}
          fallback={<ToolSection class="text-muted-foreground/70">no output</ToolSection>}
        >
          <pre
            class="max-h-80 overflow-auto bg-terminal px-3 py-2 leading-[1.55] whitespace-pre-wrap text-foreground/85"
            ref={scroller}
          >
            <Show when={props.call.dropped}>
              {(dropped) => (
                <div class="text-muted-foreground/70">
                  … {dropped().lines.toLocaleString()} earlier lines dropped
                </div>
              )}
            </Show>
            <AnsiOutput output={output()} />
            <Show when={running()}>
              <Caret />
            </Show>
          </pre>
        </Show>
        <ToolDiagnostics
          diagnostics={props.call.diagnostics.filter((d) => d.code !== 'tool_error')}
        />
      </ToolContent>
    </Tool>
  )
}

export function BashLine(props: Pick<SolidToolProps, 'call'>) {
  const { display, parsed, firstLine } = useCommand(() => props.call)
  return (
    <>
      <span class="text-foreground/80">$</span>{' '}
      <Show when={parsed()} fallback={firstLine()}>
        <BashSummary steps={display().steps} />
      </Show>
    </>
  )
}
