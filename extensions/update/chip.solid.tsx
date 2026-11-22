import { ArrowDown, Check, LoaderCircle, RefreshCw, TriangleAlert } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { createMemo, createSignal, For, Match, Show, Switch } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Popover, PopoverContent } from '@/components/ui/popover.solid.tsx'
import { StatusPopoverTrigger } from '@/components/ui/status-trigger.solid.tsx'
import {
  api,
  cn,
  errorMessage,
  events,
  formatAgo,
  keepLast,
  ROOT,
  showSurface,
  switchConversation,
  useAction,
  useRestart,
  useSystem,
  writingAs,
} from '@/sdk/solid'
import { itemOf } from './item.ts'
import { CheckAction, MergeAction, StateAction, UpdateAction } from './refs.ts'
import type { Layers, UpdateResult, UpdateState } from './refs.ts'

const short = (root: string) => root.replace(/^\/(?:home|Users)\/[^/]+/, '~')
const layerLabels = { live: 'extensions, web', core: 'server', lockfile: 'lockfile', bin: 'bin' }
const layerKeys = ['live', 'core', 'lockfile', 'bin'] as const
const actionClass = 'h-7 font-sans text-[12px]'
const spinner = () => <LoaderCircle class="size-3 animate-spin" />

function Touches(props: { layers: Layers }) {
  return (
    <span>
      <For each={layerKeys.filter((layer) => props.layers[layer])}>
        {(layer, index) => (
          <>
            {index() > 0 && ' · '}
            <span class={layer === 'live' ? undefined : 'text-warning'}>{layerLabels[layer]}</span>
          </>
        )}
      </For>
    </span>
  )
}

function AfterLine(props: { children: JSX.Element; warning?: boolean }) {
  return (
    <li class="flex gap-1.5">
      <span class="text-muted-foreground">·</span>
      <span class={cn('min-w-0', props.warning && 'text-warning')}>{props.children}</span>
    </li>
  )
}

function After(props: { layers: Layers; install?: UpdateResult & { ok: true } }) {
  return (
    <ul class="space-y-0.5">
      <Show when={props.layers.live}>
        <AfterLine>extensions and web reload by themselves</AfterLine>
      </Show>
      <Show when={props.layers.core || props.layers.lockfile}>
        <AfterLine warning>
          restart this Ultimate ({props.layers.core ? 'server changed' : 'packages changed'}), and
          every other one running from this clone
        </AfterLine>
      </Show>
      <Show when={props.layers.lockfile && props.install?.install !== 'done'}>
        <AfterLine>
          {props.install?.install === 'failed' ? 'pnpm install failed' : 'pnpm install'}
        </AfterLine>
      </Show>
      <Show when={props.layers.bin}>
        <AfterLine warning>
          bin/ changed: restart the supervisor (systemctl --user restart ultimate, or launchctl
          kickstart -k gui/$UID/com.ultimate.app)
        </AfterLine>
      </Show>
    </ul>
  )
}

function CheckNow(props: { checking: boolean; check: () => Promise<void> }) {
  return (
    <Button
      class={cn(actionClass, 'text-muted-foreground')}
      data-update-check
      disabled={props.checking}
      onClick={() => props.check()}
      size="sm"
      variant="ghost"
    >
      {props.checking ? spinner() : <RefreshCw class="size-3" />}
      {props.checking ? 'Checking…' : 'Check now'}
    </Button>
  )
}

type Controls = {
  state: UpdateState
  busy: boolean
  run: () => Promise<void>
  merge: (source: string) => Promise<void>
}

const updatedOf = (state: UpdateState) => (state.behind === 0 ? state.updated : undefined)
const owesInstallOrRestart = (state: UpdateState) =>
  !state.behind && (state.install || state.restart)

function Popup(
  props: Controls & { checking: boolean; error?: string; check: () => Promise<void> },
) {
  const state = () => props.state
  const updated = createMemo(() => updatedOf(state()))
  const owes = createMemo(() => owesInstallOrRestart(state()))
  const shown = createMemo(() => state().commits.slice(0, state().summary ? 3 : 5))
  const branch = () => state().branch ?? 'main'
  return (
    <>
      <div class="border-b border-border/70 px-3 py-2 text-[11.5px]">
        <div class="section-label">Ultimate update</div>
        <div class="truncate text-muted-foreground" title={state().root}>
          {short(state().root)}
        </div>
      </div>
      <div class="space-y-2 px-3 py-2 text-[11.5px] leading-[1.55]">
        <Switch
          fallback={
            <>
              <div>
                {branch()} is {state().behind} {state().behind === 1 ? 'commit' : 'commits'} behind
                origin/{branch()}
              </div>
              <Show when={state().summary}>
                {(summary) => (
                  <ul class="space-y-0.5 font-sans text-[12.5px] text-foreground">
                    <For each={summary()}>
                      {(line) => (
                        <li class="flex gap-1.5">
                          <span class="text-brand">•</span>
                          <span class="min-w-0">{line}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                )}
              </Show>
              <ul class="space-y-0.5">
                <For each={shown()}>
                  {(commit) => (
                    <li class="flex min-w-0 gap-2">
                      <span class="shrink-0 text-muted-foreground">{commit.sha}</span>
                      <span class="truncate text-foreground/85" title={commit.subject}>
                        {commit.subject}
                      </span>
                    </li>
                  )}
                </For>
                <Show when={state().behind > shown().length}>
                  <li class="text-muted-foreground">… {state().behind - shown().length} more</li>
                </Show>
              </ul>
              <Show when={state().compare}>
                {(compare) => (
                  <Button
                    class="h-auto self-start p-0 font-normal text-muted-foreground hover:text-brand"
                    render={(link) => (
                      <a {...link} href={compare()} rel="noreferrer" target="_blank">
                        DiffsHub ↗
                      </a>
                    )}
                    size={null}
                    variant={null}
                  />
                )}
              </Show>
              <Show when={state().layers}>
                {(layers) => (
                  <div class="border-t border-border/60 pt-2">
                    <div class="mb-0.5 text-muted-foreground">
                      Touches <Touches layers={layers()} />
                    </div>
                    <After layers={layers()} />
                  </div>
                )}
              </Show>
            </>
          }
        >
          <Match when={!state().behind && !updated() && !owes()}>
            <div>
              {props.checking ? (
                'Checking origin for new commits…'
              ) : (
                <>
                  Ultimate is <span class="text-success">up to date</span> with origin/{branch()}
                </>
              )}
            </div>
          </Match>
          <Match when={updated()}>
            {(install) => (
              <>
                <div>
                  <span class="text-success">Updated</span> {install().from}..{install().to} ·{' '}
                  {install().commits} {install().commits === 1 ? 'commit' : 'commits'}
                  {install().install === 'done' && ' · pnpm install done'}
                </div>
                <After install={install()} layers={install().layers} />
                <Show when={install().install === 'failed' && install().installError}>
                  {(message) => (
                    <pre class="max-h-40 overflow-auto whitespace-pre-wrap text-error">
                      {message()}
                    </pre>
                  )}
                </Show>
              </>
            )}
          </Match>
        </Switch>
        <Show when={owes() && !updated()}>
          <div>
            {state().install
              ? 'pnpm-lock.yaml differs from the installed packages: pnpm install is owed.'
              : 'Packages or server code changed after this Ultimate started: restart it to load them.'}
          </div>
        </Show>
        <Show when={!updated()}>
          <Show
            when={state().merge}
            fallback={
              <Show when={state().refused}>
                {(refused) => (
                  <div class="flex items-start gap-1.5 text-warning">
                    <TriangleAlert class="mt-0.5 size-3 shrink-0" />
                    <span>Can't update: {refused()}. Nothing was stashed, rebased or reset.</span>
                  </div>
                )}
              </Show>
            }
          >
            <div data-update-diverged>
              {branch()} also has {state().ahead} {state().ahead === 1 ? 'commit' : 'commits'} of
              its own, so it can't fast-forward. @ultimate can merge origin into them on a branch
              and land it once the checks pass.
            </div>
          </Show>
        </Show>
        <Show when={state().error}>
          {(error) => (
            <div class="break-words text-error" title={error()}>
              Last fetch failed: {error().split('\n')[0]}
            </div>
          )}
        </Show>
        <Show when={props.error}>
          {(error) => <div class="break-words text-error">{error()}</div>}
        </Show>
      </div>
      <div class="flex items-center justify-between gap-2 border-t border-border/70 px-3 py-1.5">
        <span class="text-[10.5px] text-muted-foreground">
          {state().fetchedAt !== undefined && !(state().refused && !state().merge && !updated())
            ? `checked ${formatAgo(state().fetchedAt!, Date.now(), { ago: true })}`
            : ''}
        </span>
        <div class="flex items-center gap-1">
          <Show when={!updated()}>
            <CheckNow check={props.check} checking={props.checking} />
          </Show>
          <Action busy={props.busy} merge={props.merge} run={props.run} state={state()} />
        </div>
      </div>
    </>
  )
}

function Action(props: Controls) {
  const restart = useRestart()
  const system = useSystem()
  const state = () => props.state
  const updated = createMemo(() => updatedOf(state()))
  return (
    <Switch>
      <Match when={!state().behind && state().install}>
        <Button
          class={actionClass}
          data-agent-confirm="Runs pnpm install in this Ultimate's clone."
          disabled={props.busy || !!state().refused}
          onClick={() => props.run()}
          size="sm"
          title={state().refused}
          variant="outline"
        >
          {props.busy ? 'Installing…' : 'Retry pnpm install'}
        </Button>
      </Match>
      <Match when={updated() || owesInstallOrRestart(state())}>
        <Show
          when={
            updated()?.layers.core ||
            updated()?.layers.lockfile ||
            system()?.code.coreStale ||
            state().restart
          }
        >
          <Button
            class={actionClass}
            data-agent-confirm="Restarts this Ultimate to load the updated code."
            disabled={restart.busy()}
            onClick={restart.run}
            size="sm"
            variant="outline"
          >
            {restart.busy() ? 'Restarting…' : 'Restart now'}
          </Button>
        </Show>
      </Match>
      <Match when={state().behind !== 0 && state().merge}>
        <Button
          class={actionClass}
          data-agent-confirm="Asks @ultimate to merge incoming commits into this clone."
          data-update-merge
          disabled={props.busy}
          onClick={(_event, details) => props.merge(details.source)}
          size="sm"
          variant="outline"
        >
          {props.busy ? 'Asking…' : 'Update with @ultimate'}
        </Button>
      </Match>
      <Match when={state().behind !== 0}>
        <Button
          class={actionClass}
          data-agent-confirm="Fast-forwards this Ultimate's clone to origin."
          data-update-now
          disabled={props.busy || !!state().refused}
          onClick={() => props.run()}
          size="sm"
          title={state().refused}
          variant="outline"
        >
          {props.busy ? 'Updating…' : 'Update now'}
        </Button>
      </Match>
    </Switch>
  )
}

export function Chip() {
  const { data, refetch } = useAction(StateAction, null, {
    conversation: ROOT,
    onError: keepLast,
    every: 60_000,
  })
  const [busy, setBusy] = createSignal(false)
  const [checking, setChecking] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const item = createMemo(() => {
    const state = data()
    return state ? itemOf(state) : 'none'
  })
  const report = (failure: unknown) => setError(errorMessage(failure))
  const check = async () => {
    setChecking(true)
    setError(undefined)
    try {
      await api.action(CheckAction, null, { conversationId: ROOT }).catch(report)
      await refetch()
    } finally {
      setChecking(false)
    }
  }
  const run = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await api.action(UpdateAction, null, { conversationId: ROOT }).catch(report)
    } finally {
      setBusy(false)
      void refetch()
    }
  }
  const merge = async (source: string) => {
    setBusy(true)
    setError(undefined)
    try {
      const { id } = await api.action(MergeAction, null, { conversationId: ROOT })
      writingAs(source, () => {
        events.emit('ultimate:sent', { conversationId: id })
        showSurface('agent')
        switchConversation(id)
      })
    } catch (failure) {
      report(failure)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Show when={item() !== 'none' && data()}>
      {(state) => {
        const refused = () => state().refused && !state().merge
        return (
          <Popover>
            <StatusPopoverTrigger
              aria-label="Updates to the Ultimate clone"
              class={cn(
                'data-open:bg-transparent hover:data-open:bg-accent',
                item() === 'current'
                  ? 'text-muted-foreground/70 data-open:text-muted-foreground/70 hover:data-open:text-foreground'
                  : !busy() && (!state().behind || refused())
                    ? 'text-warning hover:text-warning data-open:text-warning'
                    : 'text-brand hover:text-brand data-open:text-brand',
              )}
              data-update
              title="Updates to the Ultimate clone"
            >
              <Switch>
                <Match when={item() === 'current'}>
                  {checking() ? spinner() : <Check class="size-3" />}
                  <span class="max-md:hidden">up to date</span>
                </Match>
                <Match when={item() === 'install'}>
                  <TriangleAlert class="size-3" />
                  install owed
                </Match>
                <Match when={item() === 'restart'}>
                  <Check class="size-3" />
                  <span class="max-md:hidden">updated · </span>restart
                </Match>
                <Match when={item() === 'behind'}>
                  {busy() || checking() ? (
                    spinner()
                  ) : refused() ? (
                    <TriangleAlert class="size-3" />
                  ) : (
                    <ArrowDown class="size-3" />
                  )}
                  {state().behind} new<span class="max-md:hidden"> · update</span>
                </Match>
              </Switch>
            </StatusPopoverTrigger>
            <PopoverContent
              align="end"
              class="w-[26rem] max-w-[calc(100vw-1rem)] p-0 font-mono"
              side="top"
            >
              <Popup
                busy={busy()}
                check={check}
                checking={checking()}
                error={error()}
                merge={merge}
                run={run}
                state={state()}
              />
            </PopoverContent>
          </Popover>
        )
      }}
    </Show>
  )
}
