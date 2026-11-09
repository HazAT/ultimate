import {
  ChevronRightIcon,
  CircleAlertIcon,
  CopyPlusIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  ReplaceIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  api,
  cn,
  elidePath,
  errorMessage,
  events,
  shortenPath,
  useAction,
  useEvent,
  useExtensionUiState,
  useExtensions,
  Provided,
  useSystem,
  useUltimate,
} from '@/sdk'
import type { ExtensionInfo, SystemInfo } from '@/sdk'
import {
  Heading,
  Line,
  Segmented,
  projectDialog,
  projectLists,
  sources,
  useDescribed,
} from './parts.tsx'
import { ExtensionDetails } from './ui.tsx'
import { AdoptProjectSetupAction, DecideAction, DetailsAction, SetExtensionAction } from './refs.ts'
import { switchScope } from './choices.tsx'
import { ListAction } from '../secrets/ui.tsx'
import type { Secret } from '../secrets/refs.ts'

type Scope = 'project' | 'user'

const without =
  (name: string) =>
  <T,>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => key !== name))

/** Which layer decided an extension's state: a short label and the sentence behind it. */
function decided(extension: ExtensionInfo, local: boolean): [string, string] {
  if (extension.core) return ['core', 'On: the core tier is always on, whatever the settings say']
  const state = extension.enabled ? 'On' : 'Off'
  const verb = extension.enabled ? 'enables' : 'disables'
  if (extension.source === 'project' && !local)
    return ['setup not in use', "Part of this project's setup, which is not in use"]
  if (extension.layer === 'default') return ['default', 'On: built-ins are on by default']
  if (extension.layer === 'user')
    return ['your settings', `${state}: ~/.ultimate/settings.json ${verb} it`]
  if (extension.layer === 'project')
    return ['project settings', `${state}: this project's .ultimate/settings.json ${verb} it`]
  return ['its folder', 'On: extension folders of yours and of this project are on by default']
}

/** Settings problems of the last reload, such as an unknown name or an invalid file; its last valid state applies. */
function Diagnostics({ messages }: { messages: readonly string[] }) {
  if (messages.length === 0) return null
  return (
    <section className="border-b border-border/60 bg-warning/6 px-3 py-2.5">
      <Heading className="text-warning" meta={messages.length}>
        <TriangleAlertIcon className="size-3" />
        Diagnostics
      </Heading>
      <ul className="mt-1.5 flex flex-col gap-1">
        {messages.map((text) => (
          <li
            className="font-mono text-[11px] leading-snug break-words text-foreground/85"
            key={text}
          >
            {text}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The project's setup: the remembered choice, a way to change it, and taking its setup everywhere. */
function ProjectSetup({ system }: { system: SystemInfo }) {
  const { project } = system
  const ui = useUltimate()
  const [busy, setBusy] = useState<'local' | 'global' | 'adopt'>()
  const [error, setError] = useState<string>()
  const [adopted, setAdopted] = useState(false)
  const { enable, disable } = projectLists(system)
  const copies = enable.length + disable.length
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
  const state =
    project.decision === true
      ? "Using this folder's own setup: its extensions, settings, agents, and skills."
      : project.decision === false
        ? "Using your global setup; this folder's own setup stays off."
        : project.config
          ? 'This folder has its own setup. Not chosen yet, so your global setup is in use.'
          : "This folder has no setup of its own. Choose this project's setup to keep changes to this folder only."
  return (
    <section className="border-b border-border/60 px-3 pt-3 pb-3.5">
      <Heading meta={<span className="font-mono">{project.name}</span>}>Project</Heading>
      <p className="mt-2 text-[12px] leading-snug text-muted-foreground">
        {state}
        {project.config && (
          <>
            {' '}
            <button
              className="text-brand outline-none hover:underline focus-visible:underline"
              onClick={() => ui.open(projectDialog)}
              type="button"
            >
              About this setup
            </button>
          </>
        )}
      </p>
      <Segmented
        className="mt-2.5 flex w-full"
        label="Setup for this folder"
        onChange={(value) =>
          void run(value, () => api.action(DecideAction, { local: value === 'local' }))
        }
        options={[
          {
            value: 'local',
            label: (
              <>
                {busy === 'local' && <LoaderCircleIcon className="size-3 animate-spin" />}
                This project's setup
              </>
            ),
            disabled: busy !== undefined,
          },
          {
            value: 'global',
            label: (
              <>
                {busy === 'global' && <LoaderCircleIcon className="size-3 animate-spin" />}
                Global setup
              </>
            ),
            disabled: busy !== undefined,
          },
        ]}
        // Without a setup of its own, an open question means the global setup.
        value={
          project.decision === null
            ? project.config
              ? null
              : 'global'
            : project.decision
              ? 'local'
              : 'global'
        }
      />
      {project.config && (
        <Button
          className="mt-2 h-7 w-full justify-start gap-1.5 px-2 font-mono text-[11px] text-muted-foreground"
          disabled={busy !== undefined || copies === 0}
          onClick={() => void run('adopt', () => api.action(AdoptProjectSetupAction))}
          size="sm"
          title={
            copies === 0
              ? 'Its settings turn no extensions on or off'
              : `Copy its ${copies} extension choices into ~/.ultimate/settings.json`
          }
          variant="outline"
        >
          {busy === 'adopt' ? (
            <LoaderCircleIcon className="size-3.5 animate-spin" />
          ) : (
            <CopyPlusIcon className="size-3.5" />
          )}
          Use this project's setup everywhere
        </Button>
      )}
      {error && <p className="mt-2 font-mono text-[11px] leading-snug text-error">{error}</p>}
      {adopted && (
        <p className="mt-2 font-mono text-[11px] leading-snug text-success">
          Copied {copies} choices into ~/.ultimate/settings.json
        </p>
      )}
    </section>
  )
}

const openSecrets = (name?: string) => events.emit('secrets:open', name ? { name } : {})

/**
 * Every declared or stored secret, metadata only; re-read when one is saved or deleted and when an extension turns on
 * or off, which changes who declares it.
 */
function useSecrets(system: SystemInfo | undefined) {
  // A failure only hides the secret lines; the Secrets panel shows it.
  const secrets = useAction(ListAction, null, {
    onError: () => {},
    on: system?.extensions.map((extension) => [extension.name, extension.enabled]),
  })
  useEvent('secrets:changed', () => void secrets.refetch())
  return secrets.data
}

/** One line to the full Secrets panel, with how many declared secrets are still missing. */
function SecretsLine({ secrets }: { secrets: readonly Secret[] | undefined }) {
  const missing = secrets?.filter(
    (secret) => !secret.set && !secret.via && secret.declaredBy.length > 0,
  ).length
  return (
    <button
      className="group flex w-full items-center gap-2 border-b border-border/60 px-3 py-2 text-left outline-none hover:bg-muted/40 focus-visible:bg-muted/40"
      onClick={() => openSecrets()}
      type="button"
    >
      <Heading className="flex-1 group-hover:text-foreground">
        <KeyRoundIcon className="size-3" />
        Secrets
      </Heading>
      {missing ? (
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-warning">
          <span className="size-1.5 rounded-full bg-warning" />
          {missing} missing
        </span>
      ) : (
        secrets?.length !== undefined && (
          <span className="font-mono text-[11px] text-muted-foreground/70">
            {secrets.length ? 'all set' : 'none needed'}
          </span>
        )
      )}
      <ChevronRightIcon className="size-3 text-muted-foreground/60 group-hover:text-foreground" />
    </button>
  )
}

/** The secrets an extension declares, set or missing, each opening the Secrets panel at its row. Never a value. */
function RowSecrets({ secrets }: { secrets: readonly Secret[] }) {
  if (secrets.length === 0) return null
  return (
    <ul className="mt-1 flex flex-col gap-0.5 pl-[18px]">
      {secrets.map((secret) => (
        <li className="flex items-center gap-1.5 font-mono text-[11px]" key={secret.name}>
          <KeyRoundIcon className="size-3 shrink-0 text-muted-foreground/60" />
          <span className="min-w-0 truncate text-foreground/80" title={secret.description}>
            {secret.name}
          </span>
          <span
            className={cn(
              'flex shrink-0 items-center gap-1',
              secret.set || secret.via ? 'text-muted-foreground/70' : 'text-warning',
            )}
          >
            <span
              className={cn(
                'size-1.5 rounded-full',
                secret.set || secret.via ? 'bg-success' : 'bg-warning',
              )}
            />
            {secret.set ? 'set' : secret.via ? `via ${secret.via}` : 'missing'}
          </span>
          <button
            className="ml-auto shrink-0 text-[11px] text-brand outline-none hover:underline focus-visible:underline"
            onClick={() => openSecrets(secret.name)}
            type="button"
          >
            {secret.set ? 'Replace' : 'Add'}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** One labelled line of an open row; empty values are left to the caller's `none` line. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2">
      <span className="w-16 shrink-0 text-muted-foreground/60">{label}</span>
      <div className="min-w-0 flex-1 break-words text-foreground/80">{children}</div>
    </div>
  )
}

/** What an open row shows: tools, contract, dependencies and contributions; loaded when it opens. */
function Details({ extension }: { extension: ExtensionInfo }) {
  const web = useExtensions().find((record) => record.name === extension.name)?.extension
  const details = useAction(DetailsAction, { name: extension.name })
  const server = extension.server
  const data = details.data
  const tools = server?.tools ?? []
  const contributions = [
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
  // Each labelled list, shown only when it has something; the empty ones share one dim line.
  const lists: [string, readonly string[]][] = [
    ['provides', [...(data?.provides ?? []), ...(data?.declares ?? [])]],
    ['needs', data?.needs ?? []],
    ['wants', data?.wants ?? []],
    ['actions', extension.actions],
    ['documents', server?.docs ?? []],
    ['events', data?.events ?? []],
    ['web', contributions],
    ['secrets', (server?.secrets ?? []).map((secret) => secret.name)],
  ]
  const prompt = server?.sections.length
    ? `${server.sections.length} ${server.sections.length === 1 ? 'section' : 'sections'}`
    : ''
  const hooks = server?.hooks ? `${server.hooks} ${server.hooks === 1 ? 'hook' : 'hooks'}` : ''
  const empty = [
    ...lists.filter(([, items]) => items.length === 0).map(([label]) => label),
    ...(prompt || hooks ? [] : ['prompt']),
  ]
  return (
    <div className="mt-1.5 ml-4 flex flex-col gap-0.5 border-l border-border/60 pl-2.5 font-mono text-[11px] leading-snug">
      {data?.summary && (
        <p className="mb-1 font-sans text-[12px] text-muted-foreground">
          <Line text={data.summary} />
        </p>
      )}
      {!extension.enabled ? (
        <p className="text-muted-foreground/70">off: tools load when it's on</p>
      ) : (
        tools.length > 0 && (
          <Field label={`tools ${tools.length}`}>
            <ul className="flex flex-col gap-0.5">
              {tools.map((tool) => (
                <li className="min-w-0" key={tool.name}>
                  <span className="text-foreground/90">{tool.name}</span>
                  {tool.description && (
                    <span
                      className="line-clamp-2 font-sans text-[11.5px] text-muted-foreground"
                      title={tool.description}
                    >
                      {tool.description}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Field>
        )
      )}
      {lists.map(
        ([label, items]) =>
          items.length > 0 && (
            <Field key={label} label={label}>
              {items.join(' · ')}
            </Field>
          ),
      )}
      {(prompt || hooks) && (
        <Field label="prompt">{[prompt, hooks].filter(Boolean).join(' · ')}</Field>
      )}
      {extension.enabled && (
        <Provided input={extension.name} point={ExtensionDetails}>
          {(part) => part}
        </Provided>
      )}
      {details.loading && !data && <p className="text-muted-foreground/60">loading…</p>}
      {details.error && <p className="text-error">{errorMessage(details.error)}</p>}
      {data && extension.enabled && empty.length > 0 && (
        <p className="text-muted-foreground/50">no {empty.join(' · ')}</p>
      )}
      <p className="mt-0.5 truncate text-[10.5px] text-muted-foreground/60" title={extension.path}>
        {extension.path}
      </p>
    </div>
  )
}

function Row({
  extension,
  line,
  open,
  onOpen,
  replaces,
  local,
  scope,
  pending,
  error,
  note,
  onToggle,
  switchRef,
  secrets,
}: {
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
  switchRef: Ref<HTMLButtonElement>
}) {
  const web = useExtensions().find((record) => record.name === extension.name)
  const [label, reason] = decided(extension, local)
  const unusable = extension.source === 'project' && !local
  const failure =
    extension.enabled &&
    [
      extension.server?.error && `server.ts: ${extension.server.error}`,
      web?.error && `web.tsx: ${web.error}`,
    ]
      .filter(Boolean)
      .join('\n')
  const checked = pending ?? extension.enabled
  return (
    <li className="px-3 py-1.5">
      <div className="flex items-start gap-3">
        <button
          aria-expanded={open}
          className="group min-w-0 flex-1 text-left outline-none"
          onClick={() => onOpen(!open)}
          title={open ? 'Hide details' : 'Show tools, contract and dependencies'}
          type="button"
        >
          <span className="flex min-w-0 items-baseline gap-1.5 font-mono text-[11.5px]">
            <ChevronRightIcon
              className={cn(
                'size-3 shrink-0 self-center text-muted-foreground/60 transition-transform group-hover:text-foreground group-focus-visible:text-foreground',
                open && 'rotate-90',
              )}
            />
            <span
              className={cn(
                'shrink-0',
                failure
                  ? 'text-error'
                  : extension.enabled
                    ? 'text-foreground/90'
                    : 'text-foreground/70',
              )}
            >
              {extension.name}
            </span>
            <span
              className={cn(
                'truncate text-[10.5px]',
                extension.source === 'builtin' ? 'text-muted-foreground/70' : 'text-brand',
              )}
              title={`${extension.path}\n${reason}`}
            >
              {sources[extension.source]}
              <span className="text-muted-foreground/60"> · {label}</span>
            </span>
            {secrets.some((secret) => !secret.set && !secret.via) && (
              <span className="flex shrink-0 items-center gap-1 self-center text-[10.5px] text-warning">
                <TriangleAlertIcon className="size-3" />
                secret missing
              </span>
            )}
          </span>
          <Line
            className={cn(
              'mt-0.5 block pl-[18px] text-[12px] leading-snug text-muted-foreground',
              !open && 'line-clamp-2',
            )}
            text={line}
          />
          {/* A project folder in place of a built-in runs its own code under a trusted name. */}
          {replaces && (
            <span
              className="mt-1 flex items-center gap-1.5 font-mono text-[10.5px] text-warning"
              title={`This project's .ultimate/extensions/${extension.name} runs instead of the built-in ${extension.name}`}
            >
              <ReplaceIcon className="size-3 shrink-0" />
              {extension.source === 'project'
                ? 'replaces the built-in'
                : "this project's setup replaces it"}
            </span>
          )}
        </button>
        <span className="mt-0.5">
          <Switch
            busy={pending !== undefined}
            checked={checked}
            disabled={unusable || extension.core}
            aria-label={`${extension.name} ${scope === 'project' ? 'for this project' : 'everywhere'}`}
            onCheckedChange={onToggle}
            title={
              extension.core
                ? 'Core tier: always on'
                : unusable
                  ? "Choose this project's setup to use it"
                  : `${checked ? 'Turn off' : 'Turn on'} ${scope === 'project' ? 'for this project' : 'everywhere'}`
            }
            ref={switchRef}
          />
        </span>
      </div>
      <RowSecrets secrets={secrets} />
      {open && <Details extension={extension} />}
      {failure && (
        <p className="mt-1 line-clamp-3 font-mono text-[11px] leading-snug break-words whitespace-pre-wrap text-error/85">
          {failure}
        </p>
      )}
      {error && (
        <p className="mt-1 flex items-start gap-1.5 font-mono text-[11px] leading-snug text-error">
          <CircleAlertIcon className="mt-px size-3 shrink-0" />
          {error}
        </p>
      )}
      {note && (
        <p className="mt-1 font-mono text-[11px] leading-snug text-muted-foreground">{note}</p>
      )}
    </li>
  )
}

/**
 * Every extension, on and available, with its source, the layer that decided it, and a switch that writes the chosen
 * scope's settings. The list follows system info, so a change shows when it is live.
 */
export function ExtensionsPanel() {
  const system = useSystem()
  const { line, replaces } = useDescribed()
  const [chosen, setChosen] = useState<Scope>()
  // Names of the open rows, kept across reloads.
  const [opened, setOpened] = useExtensionUiState<string[]>('open', [])
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  // Read by screen readers once a toggle has applied, since the row has moved.
  const [announcement, setAnnouncement] = useState('')
  const secrets = useSecrets(system)
  const root = useRef<HTMLDivElement>(null)
  const switches = useRef(new Map<string, HTMLButtonElement>())
  // A toggle moves its row between On and Available, which remounts its switch; focus follows the row there.
  const follow = useRef<{ name: string; enabled: boolean }>(undefined)
  const track = (name: string, enabled: boolean) => {
    if (root.current?.contains(document.activeElement)) follow.current = { name, enabled }
  }
  useLayoutEffect(() => {
    if (!follow.current) return
    const { name, enabled } = follow.current
    const target = switches.current.get(name)
    // Only where focus fell to the document: a user who moved on keeps their place.
    if (target && (!document.activeElement || document.activeElement === document.body))
      target.focus()
    const settled =
      pending[name] === undefined &&
      system?.extensions.find((extension) => extension.name === name)?.enabled === enabled
    if (settled) follow.current = undefined
  })
  if (!system)
    return <div className="p-3 font-mono text-[11.5px] text-muted-foreground">connecting…</div>
  const local = system.project.decision === true
  const scope: Scope = switchScope(local, chosen)
  const file =
    scope === 'project'
      ? elidePath(
          shortenPath(`${system.project.root}/.ultimate/settings.json`, {
            home: system.machine.home,
          }),
          46,
        )
      : '~/.ultimate/settings.json'
  const toggle = async (extension: ExtensionInfo, enabled: boolean) => {
    const { name } = extension
    track(name, enabled)
    setPending((previous) => ({ ...previous, [name]: enabled }))
    setErrors(without(name))
    setNotes(without(name))
    try {
      await api.action(SetExtensionAction, { name, enabled, scope })
      if (scope === 'user' && extension.layer === 'project' && local) {
        const note = `Saved everywhere; this project's settings keep it ${extension.enabled ? 'on' : 'off'} here.`
        setNotes((previous) => ({ ...previous, [name]: note }))
        setAnnouncement(`${name}: ${note}`)
        // It stays where it is.
        follow.current = undefined
      } else
        setAnnouncement(
          `${name} is ${enabled ? 'on' : 'off'}, under ${enabled ? 'On' : 'Available'}`,
        )
    } catch (failure) {
      setErrors((previous) => ({ ...previous, [name]: errorMessage(failure) }))
      setAnnouncement(`${name} did not change: ${errorMessage(failure)}`)
      follow.current = undefined
    } finally {
      setPending(without(name))
    }
  }
  const sorted = system.extensions.toSorted((a, b) => a.name.localeCompare(b.name))
  const groups: [string, ExtensionInfo[]][] = [
    ['On', sorted.filter((extension) => extension.enabled)],
    ['Available', sorted.filter((extension) => !extension.enabled)],
  ]
  return (
    <div className="pb-4" ref={root}>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <Diagnostics messages={system.extensionDiagnostics} />
      <ProjectSetup system={system} />
      <SecretsLine secrets={secrets} />
      <div className="sticky top-0 z-10 border-b border-border/60 bg-sidebar/95 px-3 py-2 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <Heading className="flex-1">Changes apply</Heading>
          <Segmented
            label="Where switches save"
            onChange={setChosen}
            options={[
              {
                value: 'project',
                label: 'this project',
                disabled: !local,
                title: local
                  ? "Save to this project's .ultimate/settings.json"
                  : "Choose this project's setup to change extensions for this folder only",
              },
              {
                value: 'user',
                label: 'everywhere',
                title: 'Save to ~/.ultimate/settings.json',
              },
            ]}
            value={scope}
          />
        </div>
        <p className="mt-1 truncate font-mono text-[10.5px] text-muted-foreground/70" title={file}>
          saved in {file}
        </p>
      </div>
      {groups.map(([title, extensions]) => (
        <section aria-label={title} className="pt-3" key={title}>
          <Heading className="px-3 pb-1" meta={extensions.length}>
            {title}
          </Heading>
          <ul>
            {extensions.map((extension) => (
              <Row
                error={errors[extension.name]}
                extension={extension}
                key={extension.name}
                line={line(extension.name, extension.source)}
                local={local}
                note={notes[extension.name]}
                onOpen={(open) =>
                  setOpened((names) =>
                    open
                      ? [...names.filter((name) => name !== extension.name), extension.name]
                      : names.filter((name) => name !== extension.name),
                  )
                }
                open={opened.includes(extension.name)}
                onToggle={(enabled) => void toggle(extension, enabled)}
                pending={pending[extension.name]}
                replaces={replaces(extension.name)}
                scope={scope}
                secrets={
                  secrets?.filter((secret) => secret.declaredBy.includes(extension.name)) ?? []
                }
                switchRef={(node) => {
                  if (node) switches.current.set(extension.name, node)
                  return () => {
                    if (switches.current.get(extension.name) === node)
                      switches.current.delete(extension.name)
                  }
                }}
              />
            ))}
          </ul>
          {extensions.length === 0 && (
            <p className="px-3 py-1 text-[12px] text-muted-foreground/70">
              {title === 'On' ? 'Nothing is on.' : 'Everything is on.'}
            </p>
          )}
        </section>
      ))}
    </div>
  )
}
