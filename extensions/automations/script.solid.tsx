/** @jsxImportSource @solidjs/web */
import { ArrowLeft, RotateCw } from '@lucide/solid'
import { createEffect, For, Show } from 'solid-js'
import { HighlightedCode } from '@/components/markdown/markdown.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control.solid.tsx'
import {
  api,
  cn,
  errorMessage,
  keepLast,
  shortenPath,
  useAction,
  useExtensionUiState,
  useSystem,
} from '@/sdk/solid'
import { AnsiOutput } from '@/components/ai/ansi-output.solid.tsx'
import { looks, since } from './looks.ts'
import { Dot, Tag } from './parts.solid.tsx'
import { ErrorLine, Toggle, useAct } from './row.solid.tsx'
import { LogAction, RunAction, ScriptAction } from './refs.ts'
import type { AutomationListItem } from './refs.ts'
import { actions, automationLabel } from './words.ts'

type Detail = { automation: AutomationListItem; live: boolean; now: number }
export function ScriptDetail(props: Detail & { onBack: () => void }) {
  const { act, error } = useAct()
  return (
    <div class="flex h-full min-h-80 flex-col" data-automation-panel={props.automation.id}>
      <header class="shrink-0 px-3 pt-1.5 pb-2.5">
        <div class="-ml-1.5 flex h-7 items-center gap-2">
          <Button
            aria-label="Back to automation list"
            class="h-6 gap-1 px-1.5 section-label hover:bg-accent hover:text-foreground"
            onClick={() => props.onBack()}
            size={null}
            title="All automations"
            variant={null}
          >
            <ArrowLeft class="size-3" /> Automations
          </Button>
          <span class="ml-auto font-mono text-[11px] text-muted-foreground/70">
            {props.automation.id}
          </span>
          <Toggle act={act} automation={props.automation} now={props.now} />
        </div>
        <h2 class="mt-1 line-clamp-2 text-[13.5px] leading-snug font-medium">
          {props.automation.name}
        </h2>
        <Show when={props.automation.script?.ask !== props.automation.name}>
          <p class="mt-0.5 line-clamp-3 text-[12px] leading-snug text-muted-foreground">
            {props.automation.script?.ask}
          </p>
        </Show>
        <p class="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <Show when={props.automation.scope === 'project'}>
            <Tag>project</Tag>
          </Show>
          <span class="truncate">{actions(props.automation)}</span>
        </p>
      </header>
      <ErrorLine error={error()} />
      <Script act={act} automation={props.automation} live={props.live} now={props.now} />
    </div>
  )
}

const scriptLooks = {
  writing: 'writing',
  running: 'watching',
  investigating: 'investigating',
  failed: 'failed',
  stopped: 'paused',
  done: 'done',
} as const
function Script(props: Detail & { act: ReturnType<typeof useAct>['act'] }) {
  const script = () => props.automation.script!
  const system = useSystem()
  const pane = useExtensionUiState<'output' | 'script'>('pane', 'output')
  const log = useAction(
    LogAction,
    {
      get id() {
        return props.automation.id
      },
      lines: 200,
    },
    { every: () => (props.live ? 2000 : undefined), onError: keepLast },
  )
  const source = useAction(
    ScriptAction,
    {
      get id() {
        return props.automation.id
      },
    },
    { every: () => (props.live && pane[0]() === 'script' ? 2000 : undefined), onError: keepLast },
  )
  const output = () => log.data()?.text ?? ''
  const path = () => source.data()?.path
  const running = () => script().state === 'running'
  const look = () => scriptLooks[script().state]
  const facts = () => {
    const state = script()
    return [
      state.pid !== undefined && `pid ${state.pid}`,
      running() && state.startedAt && `up ${since(state.startedAt, props.now)}`,
      !running() && state.exitCode !== undefined && `exit ${state.exitCode}`,
      `fired ${props.automation.fires}`,
      running() && state.lastOutputAt && `output ${since(state.lastOutputAt, props.now)} ago`,
    ]
      .filter(Boolean)
      .join(' · ')
  }
  async function restart() {
    await props.act(api.action(RunAction, { id: props.automation.id }))
    await log.refetch()
  }
  return (
    <section
      class="flex min-h-0 flex-1 flex-col border-t border-border/70 font-mono text-[12px]"
      data-automation-script={props.automation.id}
    >
      <div class="flex h-9 shrink-0 items-center gap-2 pr-1.5 pl-3">
        <span class="section-label">Script</span>
        <span class={cn('flex shrink-0 items-center gap-1.5 text-[11px]', looks[look()].text)}>
          <Dot look={look()} />
          {looks[look()].word}
        </span>
        <div class="ml-auto flex shrink-0 items-center gap-1.5">
          <SegmentedControl aria-label="Watcher pane" bind={pane} class="border-0 p-0">
            <SegmentedControlItem class="px-2" value="output">
              output
            </SegmentedControlItem>
            <SegmentedControlItem class="px-2" value="script">
              script
            </SegmentedControlItem>
          </SegmentedControl>
          <span class="mx-0.5 h-4 w-px bg-border/70" />
          <Button
            aria-label={`Relaunch ${automationLabel(props.automation)}`}
            class="h-6 gap-1 px-2 font-mono text-[11px]"
            disabled={script().state === 'writing'}
            onClick={restart}
            size="xs"
            title={
              script().state === 'writing'
                ? 'The watcher starts it once the script is written'
                : 'Start the script again from the top'
            }
            variant="outline"
          >
            <RotateCw class="size-2.5" />
            {running() ? 'Restart' : 'Start'}
          </Button>
        </div>
      </div>
      <div class="flex shrink-0 flex-col gap-0.5 border-b border-border/70 px-3 pb-2 text-[11px] text-muted-foreground">
        <span class="truncate tabular-nums">{facts()}</span>
        <span class="flex min-w-0 items-center gap-2">
          <span class="shrink-0 text-muted-foreground/50">$</span>
          <span class="min-w-0 truncate text-foreground/90" title={path()}>
            {path() ? shortenPath(path()!, { home: system()?.machine.home }) : '…'}
          </span>
        </span>
        <Show when={script().error && !running()}>
          <span class={cn('line-clamp-3 break-words', looks[look()].text)} title={script().error}>
            {script().error}
          </span>
        </Show>
      </div>
      <Show
        when={pane[0]() === 'script'}
        fallback={
          <Output
            text={output()}
            error={log.error()}
            running={running()}
            writing={script().state === 'writing'}
          />
        }
      >
        <div class="min-h-0 flex-1 overflow-auto bg-terminal">
          <Show when={source.error()}>
            <p class="px-3 pt-2 text-destructive">
              Could not read run: {errorMessage(source.error())}
            </p>
          </Show>
          <Show
            when={source.data()?.text}
            fallback={
              <Show when={!source.error()}>
                <p class="px-3 py-2 text-muted-foreground/70">
                  {source.loading() ? 'loading…' : 'the script is not written yet'}
                </p>
              </Show>
            }
          >
            {(text) => (
              <pre
                aria-label="Script source"
                class="shiki min-w-max px-3 py-2 leading-[1.55] text-foreground/85"
              >
                <HighlightedCode code={text()} language={scriptLanguage(text())} lineNumbers />
              </pre>
            )}
          </Show>
        </div>
      </Show>
    </section>
  )
}

const fire = /^FIRE(\s|$)/
function Output(props: { text: string; error?: unknown; running: boolean; writing: boolean }) {
  let scroller: HTMLPreElement | undefined
  let pinned = true
  createEffect(
    () => props.text,
    () => {
      if (scroller && pinned) scroller.scrollTop = scroller.scrollHeight
    },
  )
  const lines = () => props.text.split('\n')
  return (
    <pre
      class="min-h-0 flex-1 overflow-auto bg-terminal px-3 py-2 leading-[1.55] whitespace-pre-wrap text-foreground/85"
      ref={scroller}
      onScroll={(event) => {
        const el = event.currentTarget
        pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    >
      <Show when={props.error}>
        <span class="block text-destructive">
          Could not read output: {errorMessage(props.error)}
        </span>
      </Show>
      <Show
        when={props.text}
        fallback={
          <Show when={!props.error}>
            <span class="text-muted-foreground/70">
              {props.writing ? 'no output yet · the watcher is writing the script' : 'no output'}
            </span>
          </Show>
        }
      >
        <Show
          when={lines().some((line) => fire.test(line))}
          fallback={<AnsiOutput output={props.text} />}
        >
          <For each={lines()} keyed={false}>
            {(line) => (
              <Show
                when={fire.test(line())}
                fallback={
                  <span class="block">
                    <AnsiOutput output={line() || ' '} />
                  </span>
                }
              >
                <span class="-mx-3 block border-l-2 border-success bg-success/10 px-2.5">
                  <span class="font-semibold text-success">FIRE</span>
                  {line().slice(4)}
                </span>
              </Show>
            )}
          </For>
        </Show>
      </Show>
      <Show when={props.running}>
        <span class="ml-px inline-block h-3.5 w-1.5 animate-pulse-dot bg-success align-middle" />
      </Show>
    </pre>
  )
}

const languages: Record<string, string> = {
  python: 'python',
  python3: 'python',
  node: 'javascript',
  bun: 'typescript',
  deno: 'typescript',
  ruby: 'ruby',
}
const scriptLanguage = (text: string) =>
  languages[/^#!\S*?(?:env\s+)?(\S+)/.exec(text)?.[1]?.split('/').pop() ?? ''] ?? 'shell'
