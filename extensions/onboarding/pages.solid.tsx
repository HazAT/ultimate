import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  ReplaceIcon,
  SparklesIcon,
  X,
} from '@lucide/solid'
import { dynamic } from '@solidjs/web'
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import { Checkbox } from '@/components/ui/checkbox.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog.solid.tsx'
import {
  api,
  cn,
  errorMessage,
  events,
  runCommand,
  uncoveredComposer,
  useAgent,
  useCommands,
  useConversationId,
  useDialog,
  useModels,
  useSystem,
  writerNow,
  writingAs,
} from '@/sdk/solid'
import { DEFAULT_FAMILY, RECOMMENDED_MODELS } from '../../lib/families.ts'
import { nextTurn } from '../../lib/timers.ts'
import { SetDefaultAction } from '../models/refs.ts'
import {
  modelDialogs,
  refreshFamilies,
  runsOn,
  useFamilies,
  usePicks,
} from '../models/ui.solid.tsx'
import type { Isolation } from '../workspaces/refs.ts'
import { extensionOptions, offered } from './choices.ts'
import { Line, useDescribed } from './parts.solid.tsx'
import { FirstRunDoneAction } from './refs.ts'
import type { OnboardingStatus as Status } from './refs.ts'

export function FirstRun(props: {
  open: boolean
  onDone: (skipped: boolean) => void | Promise<void>
}) {
  const models = useModels()
  const conversationId = useConversationId()
  const agent = useAgent()
  const commands = useCommands()
  const families = useFamilies()
  const named = (name: string | undefined) =>
    models()?.models.find((m) => `${m.provider}/${m.id}` === name)
  const own = () => {
    const model = agent().model
    return model && `${model.provider}/${model.modelId}`
  }
  const picks = usePicks()
  const openingPickCount = createMemo<number | undefined>((previous) =>
    props.open ? (previous ?? picks()) : undefined,
  )
  const pickedInDialog = () => openingPickCount() !== undefined && openingPickCount() !== picks()
  const fallback = () => families()?.families.find((family) => family.name === DEFAULT_FAMILY)
  const unconfiguredModelSuggestion = () => {
    const family = fallback()
    return family && !runsOn(family)
      ? (RECOMMENDED_MODELS.map(named).find((m) => m?.available) ??
          models()?.models.find((m) => m.available))
      : undefined
  }
  const defaultToSave = createMemo(() =>
    pickedInDialog() ? named(own()) : unconfiguredModelSuggestion(),
  )
  const model = createMemo(() => defaultToSave() ?? named(own()))
  const connected = () => models()?.providers.some((p) => p.status.configured)
  const opus = () =>
    models()?.models.find((m) => m.provider === 'claude-code' && m.id === 'claude-opus-5-5')
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let body: HTMLDivElement | undefined
  let opener: string | undefined
  const next = createMemo(() =>
    !connected() ? 'auth.login' : !model()?.available ? 'model.pick' : 'continue',
  )
  const [login] = useDialog(modelDialogs.login)
  const [picker] = useDialog(modelDialogs.picker)
  const covered = createMemo(() => login() || picker())
  const primary = () =>
    body?.querySelector<HTMLButtonElement>(`[data-onboarding-command="${next()}"]`)
  createEffect(
    () => ({ covered: covered(), next: next(), open: props.open }),
    (state, before) => {
      if (!before || !state.open || state.covered || before.covered || before.next === state.next)
        return undefined
      const active = document.activeElement
      const here = !active || active === document.body || body?.contains(active)
      if (!here) return undefined
      const command = state.next
      return nextTurn(() =>
        body?.querySelector<HTMLButtonElement>(`[data-onboarding-command="${command}"]`)?.focus(),
      )
    },
  )
  const finish = async (skipped: boolean) => {
    if (busy()) return
    const source = writerNow()
    const save = defaultToSave()
    setBusy(true)
    try {
      if (!skipped && save) {
        await api.action(
          SetDefaultAction,
          { model: `${save.provider}/${save.id}` },
          { conversationId: conversationId() },
        )
        await refreshFamilies()
      }
      const done = props.onDone
      await writingAs(source, () => done(skipped))
      await writingAs(source, () => api.action(FirstRunDoneAction))
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  const has = (id: string) => commands().some((command) => command.id === id)
  return (
    <Dialog
      open={props.open && !covered()}
      closeOnOutsidePress={false}
      persistentElements={['[data-splash]']}
      onOpenChange={(isOpen) => {
        if (!isOpen && !covered()) void finish(true)
      }}
    >
      <DialogContent
        inline
        class="gap-5 sm:max-w-xl"
        ref={body}
        showCloseButton={false}
        initialFocus={() => {
          const id = opener
          opener = undefined
          return (
            (id && body?.querySelector<HTMLButtonElement>(`[data-onboarding-command="${id}"]`)) ||
            primary()
          )
        }}
        finalFocus={() => (props.open ? null : uncoveredComposer())}
      >
        <header>
          <span class="font-mono text-xs tracking-[0.3em] text-brand">ULTIMATE</span>
          <DialogTitle class="mt-5 text-[22px]">Get ready</DialogTitle>
          <DialogDescription class="mt-2">
            Two steps and Ultimate can start working in this folder.
          </DialogDescription>
        </header>
        <ul
          aria-live="polite"
          class="divide-y divide-border rounded-lg border border-border bg-card"
        >
          <li class="flex items-center gap-3 p-4">
            <Show when={connected()} fallback={<CircleIcon class="size-4 text-muted-foreground" />}>
              <CheckIcon class="size-4 text-success" />
            </Show>
            <span class="flex-1 text-sm">Connect a model provider</span>
            <Show when={has('auth.login')}>
              <Button
                size="sm"
                variant="outline"
                data-onboarding-command="auth.login"
                onClick={() => {
                  opener = 'auth.login'
                  runCommand(opener)
                }}
              >
                {connected() ? 'Manage' : 'Connect'}
              </Button>
            </Show>
          </li>
          <li class="flex items-center gap-3 p-4">
            <Show
              when={model()?.available}
              fallback={<CircleIcon class="size-4 text-muted-foreground" />}
            >
              <CheckIcon class="size-4 text-success" />
            </Show>
            <span class="min-w-0 flex-1 text-sm">
              Choose a model
              <span class="mt-1 block truncate font-mono text-xs text-muted-foreground">
                {model()?.id ?? 'No model chosen yet'}
              </span>
              <span class="mt-1 block text-xs text-muted-foreground">
                <Show
                  when={model() && model()!.contextWindow < 1_000_000}
                  fallback="1M+ context recommended for @ultimate."
                >
                  {Math.round(model()!.contextWindow / 1000)}k context. @ultimate works best with
                  1M+.
                </Show>
              </span>
              <Show when={defaultToSave()}>
                <span class="mt-1 block text-xs text-muted-foreground">
                  @ultimate, new conversations and branches start on it, thinking high.
                </span>
              </Show>
              <Show when={model()?.provider !== 'claude-code' || model()?.id !== 'claude-opus-5-5'}>
                <span class="mt-1 block text-xs text-muted-foreground">
                  Recommended: Opus 5.5 through Claude Code.
                  <Show when={!opus()?.available && has('claude-code.panel')}>
                    {' '}
                    <Button
                      size={null}
                      variant={null}
                      class="inline text-xs font-normal underline underline-offset-2 hover:text-foreground"
                      onClick={() => runCommand('claude-code.panel')}
                    >
                      Set up Claude Code
                    </Button>
                  </Show>
                </span>
              </Show>
            </span>
            <Show when={has('model.pick')}>
              <Button
                size="sm"
                variant="outline"
                data-onboarding-command="model.pick"
                onClick={() => {
                  opener = 'model.pick'
                  runCommand(opener)
                }}
              >
                {model()?.available ? 'Change' : 'Choose'}
              </Button>
            </Show>
          </li>
        </ul>
        <Show when={error()}>
          <p class="text-xs text-error">{error()}</p>
        </Show>
        <footer class="flex justify-end border-t border-border pt-3">
          <Button
            size="sm"
            aria-label="Continue from Get ready"
            data-onboarding-command="continue"
            disabled={busy() || !connected() || !model()?.available || !families()}
            onClick={() => finish(false)}
          >
            Continue
          </Button>
        </footer>
        <DialogClose
          aria-label="Close Get ready"
          class="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden"
        >
          <X class="size-4" aria-hidden="true" />
        </DialogClose>
      </DialogContent>
    </Dialog>
  )
}

export function Recommended(props: {
  status?: Status
  onDone: (choice: { extensions: Record<string, boolean> }) => Promise<void>
  id: string
}) {
  const [changed, setChanged] = createSignal<Record<string, boolean>>({})
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const { line } = useDescribed()
  const system = useSystem()
  const options = createMemo(() =>
    extensionOptions(props.status?.user ?? { enable: [], disable: [] }, changed()),
  )
  const runningExtensions = createMemo(() =>
    (system()?.extensions ?? [])
      .filter((info) => info.enabled && !offered.some((entry) => entry.name === info.name))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
  )
  const checked = () =>
    Object.fromEntries(options().map(({ name, checked: value }) => [name, value]))
  const check = (name: string, enabled: boolean) => {
    const next = { ...checked(), [name]: enabled }
    for (const entry of offered) {
      if (enabled && entry.name === name && entry.needs) next[entry.needs] = true
      if (!enabled && entry.needs === name) next[entry.name] = false
    }
    setChanged(next)
  }
  const apply = async () => {
    if (busy() || !props.status) return
    setBusy(true)
    try {
      const extensions = checked()
      for (const entry of offered)
        if (entry.needs && extensions[entry.name]) extensions[entry.needs] = true
      await props.onDone({ extensions })
    } catch (failure) {
      setError(errorMessage(failure))
      setBusy(false)
    }
  }
  return (
    <div class="space-y-4 p-4">
      <p class="text-sm text-foreground/85">
        Everything you need is on already. These extras are optional: tick any you want, or just
        continue. You can change them any time under ⌘K → Extensions.
      </p>
      <ul class="divide-y divide-border/70 rounded-md border border-border/70">
        <For each={options()} keyed={(entry) => entry.name}>
          {(entry) => (
            <li>
              <label class="flex items-start gap-3 px-3 py-2.5 hover:bg-accent/40">
                <Checkbox
                  class="mt-0.5"
                  aria-label={`Enable ${entry().name} (setup ${props.id})`}
                  disabled={busy() || !props.status}
                  checked={entry().checked}
                  onCheckedChange={(value) => check(entry().name, value === true)}
                />
                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <Line class="text-sm" text={line(entry().name) || entry().name} />
                  <span class="font-mono text-[11px] text-muted-foreground/70">
                    {entry().name}
                    {entry().needs && ` · turns on ${entry().needs} too`}
                  </span>
                </span>
              </label>
            </li>
          )}
        </For>
      </ul>
      <Show when={runningExtensions().length > 0}>
        <Collapsible>
          <CollapsibleTrigger
            aria-label={`Already enabled extensions (setup ${props.id})`}
            class="group flex items-center gap-1.5 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRightIcon class="size-3.5 transition-transform group-data-open:rotate-90" />
            {runningExtensions().length} more are on already
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul class="mt-2 space-y-1 pl-5">
              <For each={runningExtensions()} keyed={(info) => info.name}>
                {(info) => (
                  <li class="flex min-w-0 items-baseline gap-3 text-xs">
                    <span class="w-24 shrink-0 truncate font-mono text-muted-foreground">
                      {info().name}
                    </span>
                    <Line
                      class="min-w-0 truncate text-muted-foreground/80"
                      text={line(info().name, info().source)}
                    />
                  </li>
                )}
              </For>
            </ul>
          </CollapsibleContent>
        </Collapsible>
      </Show>
      <Show when={error()}>
        <p class="text-xs text-error">{error()}</p>
      </Show>
      <div class="flex justify-end">
        <Button
          aria-label={`Continue with recommended extensions (setup ${props.id})`}
          disabled={busy() || !props.status}
          size="sm"
          onClick={apply}
        >
          <Show when={busy()}>
            <LoaderCircleIcon class="animate-spin" />
          </Show>
          Continue
        </Button>
      </div>
    </div>
  )
}

function SetupContents(props: { adds?: Status['adds']; id: string }) {
  const system = useSystem()
  const chips = createMemo(() => {
    const adds = props.adds
    return adds
      ? [
          ...adds.replaces.map((name) => ({ name, kind: 'replaces', icon: ReplaceIcon })),
          ...adds.extensions.map((name) => ({ name, kind: 'extensions', icon: undefined })),
          ...adds.enable
            .filter((name) => !adds.extensions.includes(name) && !adds.replaces.includes(name))
            .map((name) => ({ name, kind: 'enable', icon: undefined })),
          ...adds.disable.map((name) => ({ name, kind: 'disable', icon: undefined })),
          ...adds.agents.map((name) => ({ name, kind: 'agent', icon: BotIcon })),
          ...adds.skills.map((name) => ({ name, kind: 'skill', icon: SparklesIcon })),
        ]
      : []
  })
  return (
    <>
      <ul aria-label="What it brings" class="flex flex-wrap gap-1.5">
        <For each={chips()} keyed={(chip) => `${chip.kind}:${chip.name}`}>
          {(chip) => {
            const kind = () => chip().kind
            const icon = createMemo(() => chip().icon)
            const Icon = dynamic(icon)
            return (
              <li
                title={
                  kind() === 'enable'
                    ? 'A built-in it turns on'
                    : kind() === 'disable'
                      ? 'A built-in it turns off'
                      : kind()
                }
                class={cn(
                  'inline-flex items-center gap-1 rounded-sm border border-border/80 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80',
                  kind() === 'replaces' && 'border-warning/40 bg-warning/8 text-warning',
                  kind() === 'extensions' && 'border-brand/30 text-brand',
                  kind() === 'disable' && 'text-muted-foreground line-through',
                )}
              >
                <Icon class="size-3 shrink-0" />
                {chip().name}
                <Show when={kind() === 'replaces'}>
                  <span class="font-sans text-[10.5px]">replaces built-in</span>
                </Show>
              </li>
            )
          }}
        </For>
        <Show when={props.adds && chips().length === 0}>
          <li class="rounded-sm border border-border/80 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            settings only
          </li>
        </Show>
      </ul>
      <Show when={system()?.project.readme}>
        {(readme) => (
          <Collapsible>
            <CollapsibleTrigger
              aria-label={`What's in this project's setup (${props.id})`}
              class="flex items-center gap-1 text-xs text-brand"
            >
              <ChevronRightIcon class="size-3" />
              What's in it
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Markdown class="mt-2 rounded border border-border p-3 text-sm" text={readme()} />
            </CollapsibleContent>
          </Collapsible>
        )}
      </Show>
    </>
  )
}

export function ProjectCard(props: {
  adds?: Status['adds']
  onDone: (choice: { local: boolean }) => Promise<void>
  id: string
}) {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const decide = async (local: boolean) => {
    if (busy()) return
    setBusy(true)
    try {
      await props.onDone({ local })
    } catch (failure) {
      setError(errorMessage(failure))
      setBusy(false)
    }
  }
  return (
    <div class="space-y-4 p-4">
      <p class="text-xs text-muted-foreground">Runs its extensions on this machine.</p>
      <SetupContents adds={props.adds} id={props.id} />
      <Show when={error()}>
        <p class="text-xs text-error">{error()}</p>
      </Show>
      <div class="flex justify-end gap-2">
        <Button
          aria-label={`Keep global setup (${props.id})`}
          disabled={busy()}
          size="sm"
          variant="outline"
          onClick={() => decide(false)}
        >
          Keep global
        </Button>
        <Button
          aria-label={`Use this project's setup (${props.id})`}
          disabled={busy()}
          size="sm"
          onClick={() => decide(true)}
        >
          Use it
        </Button>
      </div>
    </div>
  )
}

export function GitCard(props: {
  isolation?: Isolation
  onDone: (choice: { initialize: boolean }) => Promise<void>
  id: string
}) {
  const [retryInitialization, setRetryInitialization] = createSignal<boolean>()
  const initialize = () =>
    retryInitialization() ??
    (props.isolation?.empty === true || (props.isolation !== undefined && !props.isolation.reason))
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const apply = async () => {
    if (busy()) return
    const source = writerNow()
    const value = initialize()
    setBusy(true)
    setRetryInitialization(value)
    try {
      await props.onDone({ initialize: value })
      writingAs(source, () => events.emit('onboarding:git', null))
    } catch (failure) {
      setError(errorMessage(failure))
      setBusy(false)
    }
  }
  const label = () => (initialize() ? 'Set up Git' : 'Let @ultimate do it')
  return (
    <div class="space-y-4 p-4">
      <p class="text-xs text-muted-foreground">{props.isolation?.reason}</p>
      <p class="text-sm leading-relaxed">
        With Git, each conversation gets its own checkout. Finished work lands on your branch
        through the lander, which runs your checks first. Until then, conversations share this
        folder.
      </p>
      <p class="flex gap-2 rounded-md border border-border bg-sidebar p-3 text-xs leading-relaxed text-muted-foreground">
        <GitBranchIcon class="size-4 shrink-0 text-brand" />
        {initialize()
          ? 'The folder is empty, so Ultimate runs git init and makes an empty first commit.'
          : 'The folder has files. @ultimate chooses what the first commit holds, without secrets, dependencies or build output. No remote, no push.'}
      </p>
      <Show when={error()}>
        <p class="text-xs text-error">{error()}</p>
      </Show>
      <div class="flex justify-end">
        <Button
          aria-label={`${label()} (setup ${props.id})`}
          disabled={busy() || (!props.isolation && retryInitialization() === undefined)}
          size="sm"
          onClick={apply}
        >
          {label()}
        </Button>
      </div>
    </div>
  )
}
