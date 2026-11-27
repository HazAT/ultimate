import {
  ChevronRightIcon,
  CircleAlertIcon,
  CopyPlusIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  ReplaceIcon,
  TriangleAlertIcon,
} from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Switch } from '@/components/ui/switch.solid.tsx'
import {
  Provided,
  api,
  cn,
  elidePath,
  errorMessage,
  events,
  keepLast,
  shortenPath,
  ROOT,
  useAction,
  useDialog,
  useEvent,
  useExtensionUiState,
  useExtensions,
  useSystem,
} from '@/sdk/solid'
import type { ExtensionInfo, SystemInfo } from '../../shared/protocol.ts'
import { ListAction } from '../secrets/refs.ts'
import type { Secret } from '../secrets/refs.ts'
import { Heading, Line, Segmented, projectLists, sources, useDescribed } from './parts.solid.tsx'
import { ExtensionDetails, projectHelpDialog } from './points.web.ts'
import { switchScope } from './scope.web.ts'
import { AdoptProjectSetupAction, DecideAction, DetailsAction, SetExtensionAction } from './refs.ts'

type Scope = 'project' | 'user'

const without =
  (name: string) =>
  <T,>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => key !== name))

const switchedOn = (extension: ExtensionInfo) => extension.enabled || !!extension.offForMissing

function decided(extension: ExtensionInfo, local: boolean): [string, string] {
  if (extension.core) return ['core', 'On: the core tier is always on, whatever the settings say']
  const state = extension.enabled ? 'On' : 'Off'
  const verb = switchedOn(extension) ? 'enables' : 'disables'
  if (extension.source === 'project' && !local)
    return ['setup not in use', "Part of this project's setup, which is not in use"]
  if (extension.layer === 'default') return ['default', 'On: built-ins are on by default']
  if (extension.layer === 'user')
    return ['your settings', `${state}: ~/.ultimate/settings.json ${verb} it`]
  if (extension.layer === 'project')
    return ['project settings', `${state}: this project's .ultimate/settings.json ${verb} it`]
  return ['its folder', 'On: extension folders of yours and of this project are on by default']
}

function Diagnostics(props: { messages: readonly string[] }) {
  return (
    <Show when={props.messages.length > 0}>
      <section class="border-b border-border/60 bg-warning/6 px-3 py-2.5">
        <Heading class="text-warning" meta={props.messages.length}>
          <TriangleAlertIcon class="size-3" />
          Diagnostics
        </Heading>
        <ul class="mt-1.5 flex flex-col gap-1">
          <For each={props.messages}>
            {(text) => (
              <li class="font-mono text-[11px] leading-snug break-words text-foreground/85">
                {text}
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  )
}

function ProjectSetup(props: { system: SystemInfo }) {
  const project = () => props.system.project
  const [, setProjectOpen] = useDialog(projectHelpDialog)
  const [busy, setBusy] = createSignal<'local' | 'global' | 'adopt'>()
  const [error, setError] = createSignal<string>()
  const [adopted, setAdopted] = createSignal(false)
  const copies = createMemo(() => {
    const { enable, disable } = projectLists(props.system)
    return enable.length + disable.length
  })
  const run = async (kind: 'local' | 'global' | 'adopt', action: () => Promise<unknown>) => {
    setBusy(kind)
    setError(undefined)
    setAdopted(false)
    try {
      await action()
      if (kind === 'adopt') setAdopted(true)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(undefined)
    }
  }
  const state = () =>
    project().decision === true
      ? "Using this folder's own setup: its extensions, settings, agents, and skills."
      : project().decision === false
        ? "Using your global setup; this folder's own setup stays off."
        : project().config
          ? 'This folder has its own setup. Not chosen yet, so your global setup is in use.'
          : "This folder has no setup of its own. Choose this project's setup to keep changes to this folder only."
  const setupScope = () =>
    project().decision === null
      ? project().config
        ? null
        : 'global'
      : project().decision
        ? 'local'
        : 'global'
  return (
    <section class="border-b border-border/60 px-3 pt-3 pb-3.5">
      <Heading meta={<span class="font-mono">{project().name}</span>}>Project</Heading>
      <p class="mt-2 text-[12px] leading-snug text-muted-foreground">
        {state()}
        <Show when={project().config}>
          {' '}
          <Button
            size={null}
            variant={null}
            class="inline text-[length:inherit] leading-[inherit] font-normal text-brand outline-none hover:underline focus-visible:underline"
            onClick={() => setProjectOpen(true)}
          >
            About this setup
          </Button>
        </Show>
      </p>
      <Segmented
        class="mt-2.5 flex w-full"
        label="Setup for this folder"
        onChange={(value) =>
          void run(value, () => api.action(DecideAction, { local: value === 'local' }))
        }
        options={[
          {
            value: 'local',
            label: "This project's setup",
            busy: busy() === 'local',
            disabled: busy() !== undefined,
          },
          {
            value: 'global',
            label: 'Global setup',
            busy: busy() === 'global',
            disabled: busy() !== undefined,
          },
        ]}
        value={setupScope()}
      />
      <Show when={project().config}>
        <Button
          class="mt-2 h-7 w-full justify-start gap-1.5 px-2 font-mono text-[11px] text-muted-foreground"
          disabled={busy() !== undefined || copies() === 0}
          onClick={() => run('adopt', () => api.action(AdoptProjectSetupAction))}
          size="sm"
          title={
            copies() === 0
              ? 'Its settings turn no extensions on or off'
              : `Copy its ${copies()} extension choices into ~/.ultimate/settings.json`
          }
          variant="outline"
        >
          <Show when={busy() === 'adopt'} fallback={<CopyPlusIcon class="size-3.5" />}>
            <LoaderCircleIcon class="size-3.5 animate-spin" />
          </Show>
          Use this project's setup everywhere
        </Button>
      </Show>
      <Show when={error()}>
        <p class="mt-2 font-mono text-[11px] leading-snug text-error">{error()}</p>
      </Show>
      <Show when={adopted()}>
        <p class="mt-2 font-mono text-[11px] leading-snug text-success">
          Copied {copies()} choices into ~/.ultimate/settings.json
        </p>
      </Show>
    </section>
  )
}

const openSecrets = (name?: string) => events.emit('secrets:open', name ? { name } : {})

function SecretsLine(props: { secrets?: readonly Secret[] }) {
  const missing = () =>
    props.secrets?.filter((secret) => !secret.set && !secret.via && secret.declaredBy.length > 0)
      .length
  return (
    <Button
      size={null}
      variant={null}
      aria-label="Open secrets panel"
      class="group flex w-full items-center gap-2 rounded-none border-b border-border/60 px-3 py-2 text-left font-normal outline-none hover:bg-muted/40 focus-visible:bg-muted/40"
      onClick={() => openSecrets()}
    >
      <Heading class="flex-1 group-hover:text-foreground">
        <KeyRoundIcon class="size-3" />
        Secrets
      </Heading>
      <Show
        when={missing()}
        fallback={
          <Show when={props.secrets}>
            <span class="font-mono text-[11px] text-muted-foreground/70">
              {props.secrets?.length ? 'all set' : 'none needed'}
            </span>
          </Show>
        }
      >
        <span class="flex items-center gap-1.5 font-mono text-[11px] text-warning">
          <span class="size-1.5 rounded-full bg-warning" />
          {missing()} missing
        </span>
      </Show>
      <ChevronRightIcon class="size-3 text-muted-foreground/60 group-hover:text-foreground" />
    </Button>
  )
}

function RowSecrets(props: { secrets: readonly Secret[]; extension: string }) {
  return (
    <Show when={props.secrets.length > 0}>
      <ul class="mt-1 flex flex-col gap-0.5 pl-[18px]">
        <For each={props.secrets} keyed={(secret) => secret.name}>
          {(secret) => (
            <li class="flex items-center gap-1.5 font-mono text-[11px]">
              <KeyRoundIcon class="size-3 shrink-0 text-muted-foreground/60" />
              <span class="min-w-0 truncate text-foreground/80" title={secret().description}>
                {secret().name}
              </span>
              <span
                class={cn(
                  'flex shrink-0 items-center gap-1',
                  secret().set || secret().via ? 'text-muted-foreground/70' : 'text-warning',
                )}
              >
                <span
                  class={cn(
                    'size-1.5 rounded-full',
                    secret().set || secret().via ? 'bg-success' : 'bg-warning',
                  )}
                />
                {secret().set ? 'set' : secret().via ? `via ${secret().via}` : 'missing'}
              </span>
              <Button
                size={null}
                variant={null}
                aria-label={`${secret().set ? 'Replace' : 'Add'} secret ${secret().name} for ${props.extension}`}
                class="ml-auto shrink-0 text-[11px] leading-[inherit] font-normal text-brand outline-none hover:underline focus-visible:underline"
                onClick={() => openSecrets(secret().name)}
              >
                {secret().set ? 'Replace' : 'Add'}
              </Button>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}

function Field(props: { label: string; children: JSX.Element }) {
  return (
    <div class="flex min-w-0 gap-2">
      <span class="w-16 shrink-0 text-muted-foreground/60">{props.label}</span>
      <div class="min-w-0 flex-1 break-words text-foreground/80">{props.children}</div>
    </div>
  )
}

function Details(props: { extension: ExtensionInfo }) {
  const extension = () => props.extension
  const records = useExtensions()
  const details = useAction(
    DetailsAction,
    {
      get name() {
        return extension().name
      },
    },
    { conversation: ROOT },
  )
  const server = () => extension().server
  const data = details.data
  const tools = () => server()?.tools ?? []
  const contributions = createMemo(() => {
    const web = records().find((record) => record.name === extension().name)?.extension
    return [
      ...Object.keys(web?.slots ?? {}).map((slot) => `slot ${slot}`),
      ...(web?.panels ?? []).map((panel) => `panel ${panel.title}`),
      ...(web?.surfaces ?? []).map((surface) => `surface ${surface.title}`),
      ...(web?.commands?.length ? [`${web.commands.length} commands`] : []),
      ...Object.keys(web?.tools ?? {}).map((tool) => `renders ${tool}`),
      ...Object.keys(web?.toolLines ?? {}).map((tool) => `step line ${tool}`),
      ...Object.keys(web?.entries ?? {}).map((kind) => `entry ${kind}`),
      ...(web?.documents ?? []).map((document) => `document ${document.kind}`),
      ...(web?.provides ?? []).map((provision) => `point ${provision.point}`),
      ...(
        [
          ['inbox', web?.inbox],
          ['composer', web?.composer],
          ['links', web?.link],
          ['compact', web?.compact],
        ] as const
      )
        .filter(([, value]) => value)
        .map(([label]) => label),
      ...(web?.messageActions?.length ? ['message actions'] : []),
      ...(web?.messageDetails?.length ? ['message details'] : []),
      ...(web?.answerLabels?.length ? ['answer labels'] : []),
      ...(web?.userBubble?.length ? ['user bubble'] : []),
    ]
  })
  const lists = createMemo((): [string, readonly string[]][] => [
    ['provides', [...(data()?.provides ?? []), ...(data()?.declares ?? [])]],
    ['requires', extension().requires ?? []],
    ['needs', data()?.needs ?? []],
    ['wants', data()?.wants ?? []],
    ['actions', extension().actions],
    ['documents', server()?.docs ?? []],
    ['events', data()?.events ?? []],
    ['web', contributions()],
    ['secrets', (server()?.secrets ?? []).map((secret) => secret.name)],
  ])
  const prompt = () => {
    const sections = server()?.sections.length
    const hooks = server()?.hooks
    return [
      sections && `${sections} ${sections === 1 ? 'section' : 'sections'}`,
      hooks && `${hooks} ${hooks === 1 ? 'hook' : 'hooks'}`,
    ]
      .filter(Boolean)
      .join(' · ')
  }
  const empty = () => [
    ...lists()
      .filter(([, items]) => items.length === 0)
      .map(([label]) => label),
    ...(prompt() ? [] : ['prompt']),
  ]
  return (
    <div class="mt-1.5 ml-4 flex flex-col gap-0.5 border-l border-border/60 pl-2.5 font-mono text-[11px] leading-snug">
      <Show when={data()?.summary}>
        {(summary) => (
          <p class="mb-1 font-sans text-[12px] text-muted-foreground">
            <Line text={summary()} />
          </p>
        )}
      </Show>
      <Show
        when={extension().enabled}
        fallback={<p class="text-muted-foreground/70">off: tools load when it's on</p>}
      >
        <Show when={tools().length > 0}>
          <Field label={`tools ${tools().length}`}>
            <ul class="flex flex-col gap-0.5">
              <For each={tools()} keyed={(tool) => tool.name}>
                {(tool) => (
                  <li class="min-w-0">
                    <span class="text-foreground/90">{tool().name}</span>
                    <Show when={tool().description}>
                      <span
                        class="line-clamp-2 font-sans text-[11.5px] text-muted-foreground"
                        title={tool().description}
                      >
                        {tool().description}
                      </span>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Field>
        </Show>
      </Show>
      <For each={lists()} keyed={([label]) => label}>
        {(list) => (
          <Show when={list()[1].length > 0}>
            <Field label={list()[0]}>{list()[1].join(' · ')}</Field>
          </Show>
        )}
      </For>
      <Show when={prompt()}>
        <Field label="prompt">{prompt()}</Field>
      </Show>
      <Show when={extension().enabled}>
        <Provided
          input={{
            get name() {
              return extension().name
            },
          }}
          point={ExtensionDetails}
        />
      </Show>
      <Show when={details.loading() && !data()}>
        <p class="text-muted-foreground/60">loading…</p>
      </Show>
      <Show when={details.error()}>
        <p class="text-error">{errorMessage(details.error())}</p>
      </Show>
      <Show when={data() && extension().enabled && empty().length > 0}>
        <p class="text-muted-foreground/50">no {empty().join(' · ')}</p>
      </Show>
      <p class="mt-0.5 truncate text-[10.5px] text-muted-foreground/60" title={extension().path}>
        {extension().path}
      </p>
    </div>
  )
}

function Row(props: {
  extension: ExtensionInfo
  secrets: readonly Secret[]
  line: string
  open: boolean
  onOpen: (open: boolean) => void
  replaces: boolean
  local: boolean
  scope: Scope
  pending?: boolean
  error?: string
  note?: string
  onToggle: (enabled: boolean) => void
  registerSwitch: (node: HTMLButtonElement) => () => void
}) {
  const extension = () => props.extension
  const records = useExtensions()
  const decision = createMemo(() => decided(extension(), props.local))
  const unusable = () => extension().source === 'project' && !props.local
  const failure = createMemo(() => {
    if (!extension().enabled) return ''
    const server = extension().server?.error
    const web = records().find((record) => record.name === extension().name)
    return [server && `server.ts: ${server}`, web?.error && `web: ${web.error}`]
      .filter(Boolean)
      .join('\n')
  })
  const checked = () => props.pending ?? switchedOn(extension())
  const where = () => (props.scope === 'project' ? 'for this project' : 'everywhere')
  return (
    <li class="px-3 py-1.5">
      <div class="flex items-start gap-3">
        <Button
          size={null}
          variant={null}
          aria-expanded={props.open ? 'true' : 'false'}
          aria-label={`${props.open ? 'Hide' : 'Show'} extension details: ${extension().name}`}
          class="group block min-w-0 flex-1 text-left font-normal whitespace-normal outline-none"
          onClick={() => props.onOpen(!props.open)}
          title={props.open ? 'Hide details' : 'Show tools, contract and dependencies'}
        >
          <span class="flex min-w-0 items-baseline gap-1.5 font-mono text-[11.5px]">
            <ChevronRightIcon
              class={cn(
                'size-3 shrink-0 self-center text-muted-foreground/60 transition-transform group-hover:text-foreground group-focus-visible:text-foreground',
                props.open && 'rotate-90',
              )}
            />
            <span
              class={cn(
                'shrink-0',
                failure()
                  ? 'text-error'
                  : extension().enabled
                    ? 'text-foreground/90'
                    : 'text-foreground/70',
              )}
            >
              {extension().name}
            </span>
            <span
              class={cn(
                'truncate text-[10.5px]',
                extension().source === 'builtin' ? 'text-muted-foreground/70' : 'text-brand',
              )}
              title={`${extension().path}\n${decision()[1]}`}
            >
              {sources[extension().source]}
              <span class="text-muted-foreground/60"> · {decision()[0]}</span>
            </span>
            <Show when={props.secrets.some((secret) => !secret.set && !secret.via)}>
              <span class="flex shrink-0 items-center gap-1 self-center text-[10.5px] text-warning">
                <TriangleAlertIcon class="size-3" />
                secret missing
              </span>
            </Show>
          </span>
          <Line
            class={cn(
              'mt-0.5 block pl-[18px] text-[12px] leading-snug text-muted-foreground',
              !props.open && 'line-clamp-2',
            )}
            text={props.line}
          />
          <Show when={props.replaces}>
            <span
              class="mt-1 flex items-center gap-1.5 font-mono text-[10.5px] text-warning"
              title={`This project's .ultimate/extensions/${extension().name} runs instead of the built-in ${extension().name}`}
            >
              <ReplaceIcon class="size-3 shrink-0" />
              {extension().source === 'project'
                ? 'replaces the built-in'
                : "this project's setup replaces it"}
            </span>
          </Show>
          <Show when={extension().offForMissing}>
            {(missing) => (
              <span class="mt-1 flex items-center gap-1.5 font-mono text-[10.5px] text-warning">
                <TriangleAlertIcon class="size-3 shrink-0" />
                off: requires {missing().join(' and ')}
              </span>
            )}
          </Show>
        </Button>
        <Show when={!extension().core}>
          <span class="mt-0.5">
            <Switch
              aria-busy={props.pending !== undefined ? 'true' : undefined}
              class={props.pending !== undefined ? 'animate-pulse cursor-progress' : undefined}
              checked={checked()}
              disabled={unusable()}
              aria-label={`${extension().name} ${where()}`}
              onCheckedChange={(enabled, details) => {
                if (props.pending !== undefined) details.cancel()
                else props.onToggle(enabled)
              }}
              title={
                unusable()
                  ? "Choose this project's setup to use it"
                  : `${checked() ? 'Turn off' : 'Turn on'} ${where()}`
              }
              ref={(node) => onCleanup(props.registerSwitch(node))}
            />
          </span>
        </Show>
      </div>
      <RowSecrets secrets={props.secrets} extension={extension().name} />
      <Show when={props.open}>
        <Details extension={extension()} />
      </Show>
      <Show when={failure()}>
        <p class="mt-1 line-clamp-3 font-mono text-[11px] leading-snug break-words whitespace-pre-wrap text-error/85">
          {failure()}
        </p>
      </Show>
      <Show when={props.error}>
        <p class="mt-1 flex items-start gap-1.5 font-mono text-[11px] leading-snug text-error">
          <CircleAlertIcon class="mt-px size-3 shrink-0" />
          {props.error}
        </p>
      </Show>
      <Show when={props.note}>
        <p class="mt-1 font-mono text-[11px] leading-snug text-muted-foreground">{props.note}</p>
      </Show>
    </li>
  )
}

export function ExtensionsPanel() {
  const system = useSystem()
  return (
    <Show
      when={system()}
      fallback={<div class="p-3 font-mono text-[11.5px] text-muted-foreground">connecting…</div>}
    >
      {(current) => <ExtensionList system={current()} />}
    </Show>
  )
}

function ExtensionList(props: { system: SystemInfo }) {
  const { line, replaces } = useDescribed()
  const [chosen, setChosen] = createSignal<Scope>()
  const [savedOpenRows, setSavedOpenRows] = useExtensionUiState<string[]>('open', [])
  const [pending, setPending] = createSignal<Record<string, boolean>>({})
  const [errors, setErrors] = createSignal<Record<string, string>>({})
  const [notes, setNotes] = createSignal<Record<string, string>>({})
  const [toggleAnnouncement, setToggleAnnouncement] = createSignal('')
  const secrets = useAction(ListAction, null, {
    conversation: ROOT,
    onError: keepLast,
    on: () => props.system.extensions.map((extension) => [extension.name, extension.enabled]),
  })
  useEvent('secrets:changed', () => void secrets.refetch())
  let root: HTMLDivElement | undefined
  const switches = new Map<string, HTMLButtonElement>()
  let remountFocus: { name: string; enabled: boolean } | undefined
  createEffect(
    () => ({ pending: pending(), extensions: props.system.extensions }),
    (state) => {
      if (!remountFocus) return
      const { name, enabled } = remountFocus
      const target = switches.get(name)
      if (target && document.activeElement === document.body) target.focus()
      if (
        state.pending[name] === undefined &&
        state.extensions.find((extension) => extension.name === name)?.enabled === enabled
      )
        remountFocus = undefined
    },
  )
  const local = () => props.system.project.decision === true
  const scope = () => switchScope(local(), chosen())
  const file = () =>
    scope() === 'project'
      ? elidePath(
          shortenPath(`${props.system.project.root}/.ultimate/settings.json`, {
            home: props.system.machine.home,
          }),
          46,
        )
      : '~/.ultimate/settings.json'
  const toggle = async (extension: ExtensionInfo, enabled: boolean) => {
    const { name } = extension
    const savingTo = scope()
    const projectSetup = local()
    if (root?.contains(document.activeElement)) remountFocus = { name, enabled }
    setPending((previous) => ({ ...previous, [name]: enabled }))
    setErrors(without(name))
    setNotes(without(name))
    try {
      await api.action(SetExtensionAction, { name, enabled, scope: savingTo })
      if (savingTo === 'user' && extension.layer === 'project' && projectSetup) {
        const note = `Saved everywhere; this project's settings keep it ${extension.enabled ? 'on' : 'off'} here.`
        setNotes((previous) => ({ ...previous, [name]: note }))
        setToggleAnnouncement(`${name}: ${note}`)
        remountFocus = undefined
      } else {
        const blocked =
          enabled &&
          extension.requires?.some(
            (required) =>
              !props.system.extensions.some((other) => other.name === required && other.enabled),
          )
        setToggleAnnouncement(
          blocked
            ? `${name} is saved on but stays off: it requires ${extension.requires!.join(' and ')}`
            : `${name} is ${enabled ? 'on' : 'off'}, under ${enabled ? 'On' : 'Available'}`,
        )
      }
    } catch (failure) {
      setErrors((previous) => ({ ...previous, [name]: errorMessage(failure) }))
      setToggleAnnouncement(`${name} did not change: ${errorMessage(failure)}`)
      remountFocus = undefined
    } finally {
      setPending(without(name))
    }
  }
  const groups = createMemo((): [string, ExtensionInfo[], string?][] => {
    const sorted = props.system.extensions.toSorted((a, b) => a.name.localeCompare(b.name))
    return [
      ['On', sorted.filter((extension) => extension.enabled && !extension.core)],
      ['Waiting on a requirement', sorted.filter((extension) => extension.offForMissing)],
      ['Available', sorted.filter((extension) => !switchedOn(extension))],
      [
        'Always on',
        sorted.filter((extension) => extension.core),
        'The core Ultimate runs on. These stay on whatever the settings say.',
      ],
    ]
  })
  return (
    <div class="pb-4" ref={root}>
      <p aria-live="polite" class="sr-only">
        {toggleAnnouncement()}
      </p>
      <Diagnostics messages={props.system.extensionDiagnostics} />
      <ProjectSetup system={props.system} />
      <SecretsLine secrets={secrets.data()} />
      <div class="sticky top-0 z-10 border-b border-border/60 bg-sidebar/95 px-3 py-2 backdrop-blur-sm">
        <div class="flex items-center gap-2">
          <Heading class="flex-1">Changes apply</Heading>
          <Segmented
            label="Where switches save"
            onChange={setChosen}
            options={[
              {
                value: 'project',
                label: 'this project',
                disabled: !local(),
                title: local()
                  ? "Save to this project's .ultimate/settings.json"
                  : "Choose this project's setup to change extensions for this folder only",
              },
              { value: 'user', label: 'everywhere', title: 'Save to ~/.ultimate/settings.json' },
            ]}
            value={scope()}
          />
        </div>
        <p class="mt-1 truncate font-mono text-[10.5px] text-muted-foreground/70" title={file()}>
          saved in {file()}
        </p>
      </div>
      <For each={groups()} keyed={([title]) => title}>
        {(group) => (
          <section aria-label={group()[0]} class="pt-3">
            <Heading class="px-3 pb-1" meta={group()[1].length}>
              {group()[0]}
            </Heading>
            <Show when={group()[2]}>
              <p class="px-3 pb-1 text-[12px] leading-snug text-muted-foreground/70">
                {group()[2]}
              </p>
            </Show>
            <ul>
              <For each={group()[1]} keyed={(extension) => extension.name}>
                {(extension) => (
                  <Row
                    error={errors()[extension().name]}
                    extension={extension()}
                    line={line(extension().name, extension().source)}
                    local={local()}
                    note={notes()[extension().name]}
                    onOpen={(open) => {
                      const name = extension().name
                      setSavedOpenRows((names) =>
                        open
                          ? [...names.filter((item) => item !== name), name]
                          : names.filter((item) => item !== name),
                      )
                    }}
                    open={savedOpenRows().includes(extension().name)}
                    onToggle={(enabled) => void toggle(extension(), enabled)}
                    pending={pending()[extension().name]}
                    replaces={replaces(extension().name)}
                    scope={scope()}
                    secrets={
                      secrets
                        .data()
                        ?.filter((secret) => secret.declaredBy.includes(extension().name)) ?? []
                    }
                    registerSwitch={(node) => {
                      const initialName = extension().name
                      switches.set(initialName, node)
                      return () => {
                        if (switches.get(initialName) === node) switches.delete(initialName)
                      }
                    }}
                  />
                )}
              </For>
            </ul>
            <Show when={group()[1].length === 0}>
              <p class="px-3 py-1 text-[12px] text-muted-foreground/70">
                {group()[0] === 'On' ? 'Nothing is on.' : 'Everything is on.'}
              </p>
            </Show>
          </section>
        )}
      </For>
    </div>
  )
}
