import { LoaderCircleIcon, MoonIcon } from '@lucide/solid'
import { Show, createMemo, createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  ROOT,
  api,
  cn,
  errorMessage,
  formatTime,
  plural,
  showSurface,
  switchConversation,
  useConversations,
  useDocOf,
  useNow,
  writerNow,
  writingAs,
} from '@/sdk/solid'
import { ContextDoc } from '../conversations/refs.ts'
import type { InboxItem } from '../inbox/ui.solid.tsx'
import { StandingDoc, talkToUltimate } from '../subagents/ui.solid.tsx'
import { DreamDoc, LaterAction, SkipAction, StartAction } from './refs.ts'
import type { Ask } from './refs.ts'

export const COMPACTION_SOON_PERCENT = 85
const SNOOZE_MS = 2 * 3600_000
const MORNING_HOUR = 9
const amber = 'text-amber-700 dark:text-amber-300'

function tomorrowMorning(now: number) {
  const morning = new Date(now)
  morning.setDate(morning.getDate() + 1)
  morning.setHours(MORNING_HOUR, 0, 0, 0)
  return morning.getTime()
}

function useAskState() {
  const doc = useDocOf(() => ROOT, DreamDoc)
  const standing = useDocOf(() => ROOT, StandingDoc)
  const ultimate = () => standing()?.ultimate
  const usage = useDocOf(() => ultimate() ?? ROOT, ContextDoc)
  const conversations = useConversations()
  const ask = () => doc()?.ask
  const now = useNow(60_000, () => ask()?.snooze !== undefined)
  const running = createMemo(
    () => conversations().filter((item) => item.busy && item.id !== ultimate()).length,
  )
  const percent = () => (ultimate() === undefined ? undefined : usage()?.percent)
  const hidden = createMemo(() => {
    const snooze = ask()?.snooze
    if (!snooze) return false
    return 'idle' in snooze ? running() > 0 : snooze.until > now()
  })
  return { ask, running, percent, hidden, ultimate }
}

const runningText = (running: number) =>
  running ? `${plural(running, 'branch')} running` : 'nothing running'

export function useAskItems() {
  const state = useAskState()
  const pane = <AskPane state={state} />
  return createMemo((): InboxItem[] => {
    const ask = state.ask()
    if (!ask || state.hidden()) return []
    const percent = state.percent()
    return [
      {
        key: 'dream:ask',
        at: ask.at,
        conversation: state.ultimate(),
        tag: 'dream',
        title: 'Start dreaming now?',
        gist: [
          runningText(state.running()),
          percent === undefined ? undefined : `context ${Math.round(percent)}%`,
        ]
          .filter(Boolean)
          .join(' · '),
        pane,
      },
    ]
  })
}

function AskPane(props: { state: ReturnType<typeof useAskState> }) {
  return (
    <Show when={props.state.ask()}>{(ask) => <AskBody ask={ask()} state={props.state} />}</Show>
  )
}

function AskBody(props: { ask: Ask; state: ReturnType<typeof useAskState> }) {
  const [failure, setFailure] = createSignal<string>()
  const soon = () => (props.state.percent() ?? 0) >= COMPACTION_SOON_PERCENT
  const run = async (step: () => Promise<unknown>) => {
    setFailure(undefined)
    try {
      await step()
    } catch (error) {
      setFailure(errorMessage(error))
    }
  }
  const start = () =>
    run(async () => {
      const source = writerNow()
      await api.action(StartAction, null)
      await writingAs(source, () => talkToUltimate({ showSurface, switchConversation }))
    })
  const trigger = () =>
    props.ask.automation.pause !== undefined
      ? `you were away ${Math.max(1, Math.round(props.ask.automation.pause / 3600_000))} h`
      : 'my context is filling up'
  return (
    <div
      class="overflow-hidden rounded-lg border border-border/70 bg-card/60"
      data-dream-ask={soon() ? 'soon' : 'open'}
    >
      <div class="space-y-3 px-4 py-3.5">
        <p class="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <MoonIcon class="size-3.5 text-brand" />
          <span>{trigger()}</span>
          <span>·</span>
          <span>automation {props.ask.automation.id}</span>
        </p>
        <ul class="list-disc space-y-1 pl-5 text-[13px] leading-5 text-muted-foreground marker:text-border">
          <li>
            I read back over this chapter and propose memory, tool and prompt changes for you to
            decide.
          </li>
          <li>It doesn't touch running work: the dream only reads.</li>
          <li>It ends with Fall asleep into a fresh chapter, when you press it.</li>
        </ul>
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 border-t border-border/60 pt-3 text-[12px]">
          <dt class="text-muted-foreground">Now</dt>
          <dd data-dream-ask-running>{runningText(props.state.running())}</dd>
          <Show when={props.state.percent()}>
            {(percent) => (
              <>
                <dt class="text-muted-foreground">Context</dt>
                <dd class={cn(soon() && amber)} data-dream-ask-context>
                  {Math.round(percent())}%{soon() && ' · compaction soon'}
                </dd>
              </>
            )}
          </Show>
          <dt class="text-muted-foreground">Handoff</dt>
          <dd>
            <Show
              when={props.ask.parked}
              fallback={
                <span class="flex items-center gap-1.5 text-muted-foreground">
                  <LoaderCircleIcon class="size-3 motion-safe:animate-spin" />
                  @ultimate is writing it
                </span>
              }
            >
              {(parked) => (
                <>
                  written {formatTime(parked())}{' '}
                  <span class="text-muted-foreground">— safe from compaction</span>
                </>
              )}
            </Show>
          </dd>
        </dl>
      </div>
      <footer class="space-y-2 border-t border-border/60 bg-muted/30 px-4 py-3">
        {failure() && (
          <p class="text-[12px] text-error" role="alert">
            {failure()}
          </p>
        )}
        <div class="flex flex-wrap items-center gap-2">
          <Button data-dream-ask-start onClick={start} size="sm">
            <MoonIcon class="size-3.5" />
            Start dreaming now
          </Button>
          <Button
            class="text-muted-foreground"
            data-dream-ask-skip
            onClick={() => run(() => api.action(SkipAction, null))}
            size="sm"
            variant="ghost"
          >
            Skip this time
          </Button>
        </div>
        <p class="flex flex-wrap items-center gap-x-1 gap-y-1 font-mono text-[11px] text-muted-foreground">
          Later:
          <Later args={{ idle: true }} label="when nothing's running" run={run} />
          ·
          <Later args={() => ({ until: Date.now() + SNOOZE_MS })} label="in 2 h" run={run} />
          ·
          <Later
            args={() => ({ until: tomorrowMorning(Date.now()) })}
            label="tomorrow morning"
            run={run}
          />
        </p>
      </footer>
    </div>
  )
}

function Later(props: {
  label: string
  args: { idle: true } | (() => { until: number })
  run: (step: () => Promise<unknown>) => Promise<void>
}) {
  return (
    <Button
      aria-label={`Dream later: ${props.label}`}
      class="rounded px-1 py-0.5 font-mono text-[11px] font-normal text-foreground/85 hover:bg-accent hover:text-foreground"
      onClick={() => {
        const args = typeof props.args === 'function' ? props.args() : props.args
        return props.run(() => api.action(LaterAction, args))
      }}
      size={null}
      variant={null}
    >
      {props.label}
    </Button>
  )
}
