import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import {
  BotIcon,
  SparklesIcon,
  ReplaceIcon,
  CheckIcon,
  CircleIcon,
  ChevronRightIcon,
  GitBranchIcon,
  LoaderCircleIcon,
} from 'lucide-react'
import {
  api,
  cn,
  errorMessage,
  events,
  useCommands,
  useConversation,
  useModels,
  useSystem,
  useStore,
  useUltimate,
} from '@/sdk'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { MessageResponse } from '@/components/ai/message'
import type { Isolation } from '../workspaces/refs.ts'
import { FirstRunDoneAction } from './refs.ts'
import type { OnboardingStatus as Status } from './refs.ts'

import { extensionOptions, recommended } from './choices.tsx'

/** Only the prerequisites remain modal. Setup choices belong in the conversation. */
export function FirstRun({
  open,
  onDone,
  onClosed,
}: {
  open: boolean
  onDone: (skipped: boolean) => void | Promise<void>
  onClosed: () => void
}) {
  const models = useModels()
  const { agent } = useConversation()
  const commands = useCommands()
  const ui = useUltimate()
  const model = models?.models.find(
    (m) => m.provider === agent.model?.provider && m.id === agent.model?.modelId,
  )
  const connected = models?.providers.some((p) => p.status.configured)
  const opus = models?.models.find(
    (m) => m.provider === 'claude-code' && m.id === 'claude-opus-5-5',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const primary = useRef<HTMLButtonElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const next = !connected ? 'auth.login' : !model?.available ? 'model.pick' : 'continue'
  const covered = useStore((state) => Object.values(state.ui.dialogs).some(Boolean))
  const was = useRef({ covered, next })
  useEffect(() => {
    const before = was.current
    was.current = { covered, next }
    if (!open || covered) return undefined
    const active = document.activeElement
    const here = !active || active === document.body || body.current?.contains(active)
    if (!before.covered && (before.next === next || !here)) return undefined
    const timer = setTimeout(() => primary.current?.focus())
    return () => clearTimeout(timer)
  }, [covered, next, open])
  const finish = async (skipped: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      await onDone(skipped)
      await api.action(FirstRunDoneAction)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  const action = (id: string, label: string) =>
    commands.some((c) => c.id === id) && (
      <RunCommand id={id} label={label} focus={next === id ? primary : undefined} />
    )
  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        // oxlint-disable-next-line typescript/no-floating-promises -- finish catches completion failures and displays them with setError.
        if (!isOpen) void finish(true)
      }}
    >
      <DialogContent
        className="gap-5 sm:max-w-xl"
        ref={body}
        onInteractOutside={(e) => e.preventDefault()}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          primary.current?.focus()
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          onClosed()
        }}
      >
        <header>
          <span className="font-mono text-xs tracking-[0.3em] text-brand">ULTIMATE</span>
          <DialogTitle className="mt-5 text-[1.375rem]">Get ready</DialogTitle>
          <DialogDescription className="mt-2">
            Two steps and Ultimate can start working in this folder.
          </DialogDescription>
        </header>
        <ul
          aria-live="polite"
          className="divide-y divide-border rounded-lg border border-border bg-card"
        >
          <li className="flex items-center gap-3 p-4">
            {connected ? (
              <CheckIcon className="size-4 text-success" />
            ) : (
              <CircleIcon className="size-4 text-muted-foreground" />
            )}
            <span className="flex-1 text-sm">Connect a model provider</span>
            {action('auth.login', connected ? 'Manage' : 'Connect')}
          </li>
          <li className="flex items-center gap-3 p-4">
            {model?.available ? (
              <CheckIcon className="size-4 text-success" />
            ) : (
              <CircleIcon className="size-4 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 text-sm">
              Choose a model
              <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                {model?.id ?? 'No model chosen yet'}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {model && model.contextWindow < 1_000_000
                  ? `${Math.round(model.contextWindow / 1000)}k context. @ultimate works best with 1M+.`
                  : '1M+ context recommended for @ultimate.'}
              </span>
              {(model?.provider !== 'claude-code' || model.id !== 'claude-opus-5-5') && (
                <span className="mt-1 block text-xs text-muted-foreground">
                  Recommended: Claude Code Opus 5.5 for @ultimate.
                  {!opus?.available && commands.some((c) => c.id === 'claude-code.panel') && (
                    <>
                      {' '}
                      <button
                        type="button"
                        className="underline underline-offset-2 hover:text-foreground"
                        onClick={() => ui.runCommand('claude-code.panel')}
                      >
                        Set up Claude Code
                      </button>
                    </>
                  )}
                </span>
              )}
            </span>
            {action('model.pick', model?.available ? 'Change' : 'Choose')}
          </li>
        </ul>
        {error && <p className="text-xs text-error">{error}</p>}
        <footer className="flex justify-end border-t border-border pt-3">
          <Button
            size="sm"
            ref={next === 'continue' ? primary : undefined}
            disabled={busy || !connected || !model?.available}
            onClick={() => void finish(false)}
          >
            Continue
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}

function RunCommand({
  id,
  label,
  focus,
}: {
  id: string
  label: string
  focus?: RefObject<HTMLButtonElement | null>
}) {
  const ui = useUltimate()
  return (
    <Button size="sm" variant="outline" ref={focus} onClick={() => ui.runCommand(id)}>
      {label}
    </Button>
  )
}

export function Recommended({
  status,
  onDone,
}: {
  status?: Status
  onDone: (choice: { extensions: Record<string, boolean> }) => Promise<void>
}) {
  const [changed, setChanged] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const core = (useSystem()?.extensions ?? []).flatMap((info) => (info.core ? [info.name] : []))
  const options = extensionOptions(status?.user ?? { enable: [], disable: [] }, changed, core)
  const checked = Object.fromEntries(options.map(({ name, checked: value }) => [name, value]))
  const check = (name: string, enabled: boolean) => {
    if (core.includes(name)) return
    const next = { ...checked, [name]: enabled }
    for (const entry of recommended) {
      if (enabled && entry.name === name && entry.needs) next[entry.needs] = true
      if (!enabled && entry.needs === name) next[entry.name] = false
    }
    setChanged(next)
  }
  const apply = async () => {
    if (busy || !status) return
    setBusy(true)
    try {
      const extensions = { ...changed, ...checked }
      for (const entry of recommended)
        if (entry.needs && checked[entry.name]) extensions[entry.needs] = true
      await onDone({ extensions })
    } catch (failure) {
      setError(errorMessage(failure))
      setBusy(false)
    }
  }
  return (
    <div className="space-y-4 p-4">
      <p className="text-xs text-muted-foreground">
        Turn on what you want; change it any time under Extensions.
      </p>
      <ul className="divide-y divide-border/70 rounded-md border border-border/70">
        {options.map((entry) => (
          <li key={entry.name}>
            <label
              className={cn(
                'flex items-center gap-3 px-3 py-3',
                !entry.required && 'cursor-pointer hover:bg-accent/40',
              )}
            >
              <Checkbox
                disabled={entry.required || busy || !status}
                checked={entry.checked}
                onCheckedChange={(value) => check(entry.name, value === true)}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
                <span className="font-mono text-xs sm:w-24 sm:shrink-0">{entry.name}</span>
                <span className="text-xs text-muted-foreground">
                  {entry.line}
                  {entry.hint && (
                    <span className="mt-0.5 block font-mono text-[0.6562rem] text-muted-foreground sm:hidden">
                      {entry.hint}
                    </span>
                  )}
                </span>
              </span>
              {entry.hint && (
                <span className="hidden font-mono text-[0.6562rem] text-muted-foreground sm:block">
                  {entry.hint}
                </span>
              )}
            </label>
          </li>
        ))}
      </ul>
      {error && <p className="text-xs text-error">{error}</p>}
      <div className="flex justify-end">
        <Button disabled={busy || !status} size="sm" onClick={() => void apply()}>
          {busy && <LoaderCircleIcon className="animate-spin" />}Continue
        </Button>
      </div>
    </div>
  )
}

function SetupContents({ adds }: { adds?: Status['adds'] }) {
  const system = useSystem()
  const chips = adds
    ? [
        ...adds.replaces.map((name) => ({ name, kind: 'replaces', Icon: ReplaceIcon })),
        ...adds.extensions.map((name) => ({ name, kind: 'extensions', Icon: undefined })),
        ...adds.enable
          .filter((name) => !adds.extensions.includes(name) && !adds.replaces.includes(name))
          .map((name) => ({ name, kind: 'enable', Icon: undefined })),
        ...adds.disable.map((name) => ({ name, kind: 'disable', Icon: undefined })),
        ...adds.agents.map((name) => ({ name, kind: 'agent', Icon: BotIcon })),
        ...adds.skills.map((name) => ({ name, kind: 'skill', Icon: SparklesIcon })),
      ]
    : []
  return (
    <>
      <ul aria-label="What it brings" className="flex flex-wrap gap-1.5">
        {chips.map(({ name, kind, Icon }) => (
          <li
            key={`${kind}:${name}`}
            title={
              kind === 'enable'
                ? 'A built-in it turns on'
                : kind === 'disable'
                  ? 'A built-in it turns off'
                  : kind
            }
            className={cn(
              'inline-flex items-center gap-1 rounded-sm border border-border/80 px-1.5 py-0.5 font-mono text-[0.6875rem] text-foreground/80',
              kind === 'replaces' && 'border-warning/40 bg-warning/8 text-warning',
              kind === 'extensions' && 'border-brand/30 text-brand',
              kind === 'disable' && 'text-muted-foreground line-through',
            )}
          >
            {Icon && <Icon className="size-3 shrink-0" />}
            {name}
            {kind === 'replaces' && (
              <span className="font-sans text-[0.6562rem]">replaces built-in</span>
            )}
          </li>
        ))}
        {adds && chips.length === 0 && (
          <li className="rounded-sm border border-border/80 px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground">
            settings only
          </li>
        )}
      </ul>
      {system?.project.readme && (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs text-brand">
            <ChevronRightIcon className="size-3" />
            What's in it
          </CollapsibleTrigger>
          <CollapsibleContent>
            <MessageResponse className="mt-2 rounded border border-border p-3 text-sm">
              {system.project.readme}
            </MessageResponse>
          </CollapsibleContent>
        </Collapsible>
      )}
    </>
  )
}

export function ProjectCard({
  adds,
  onDone,
}: {
  adds?: Status['adds']
  onDone: (choice: { local: boolean }) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const decide = async (local: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      await onDone({ local })
    } catch (failure) {
      setError(errorMessage(failure))
      setBusy(false)
    }
  }
  return (
    <div className="space-y-4 p-4">
      <p className="text-xs text-muted-foreground">Runs its extensions on this machine.</p>
      <SetupContents adds={adds} />
      {error && <p className="text-xs text-error">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button disabled={busy} size="sm" variant="outline" onClick={() => void decide(false)}>
          Keep global
        </Button>
        <Button disabled={busy} size="sm" onClick={() => void decide(true)}>
          Use it
        </Button>
      </div>
    </div>
  )
}

export function GitCard({
  isolation,
  onDone,
}: {
  isolation?: Isolation
  onDone: (choice: { initialize: boolean }) => Promise<void>
}) {
  const [initializing, setInitializing] = useState<boolean>()
  // A reload after initialization must retry the same notification, not hand Git back to the agent.
  const initialize =
    initializing ?? (isolation?.empty === true || (isolation !== undefined && !isolation.reason))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const apply = async () => {
    if (busy) return
    setBusy(true)
    try {
      setInitializing(initialize)
      await onDone({ initialize })
      events.emit('onboarding:git', null)
    } catch (failure) {
      setError(errorMessage(failure))
      setBusy(false)
    }
  }
  return (
    <div className="space-y-4 p-4">
      <p className="text-xs text-muted-foreground">{isolation?.reason}</p>
      <p className="text-sm leading-relaxed">
        With Git, each conversation gets its own checkout. Finished work lands on your branch
        through the lander, which runs your checks first. Until then, conversations share this
        folder.
      </p>
      <p className="flex gap-2 rounded-md border border-border bg-sidebar p-3 text-xs leading-relaxed text-muted-foreground">
        <GitBranchIcon className="size-4 shrink-0 text-brand" />
        {initialize
          ? 'The folder is empty, so Ultimate runs git init and makes an empty first commit.'
          : 'The folder has files. @ultimate chooses what the first commit holds, without secrets, dependencies or build output. No remote, no push.'}
      </p>
      {error && <p className="text-xs text-error">{error}</p>}
      <div className="flex justify-end">
        <Button
          disabled={busy || (!isolation && initializing === undefined)}
          size="sm"
          onClick={() => void apply()}
        >
          {initialize ? 'Set up Git' : 'Let @ultimate do it'}
        </Button>
      </div>
    </div>
  )
}
