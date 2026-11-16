import {
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  PlusIcon,
} from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  api,
  cn,
  defineWebExtension,
  errorMessage,
  events,
  formatAgo,
  keepLast,
  useAction,
  useEvent,
  useNow,
  useSystem,
  useUltimate,
} from '@/sdk'
import { DeleteAction, ListAction, SetAction } from './refs.ts'
import type { Secret } from './refs.ts'

let requestedBeforePanelMount: string | undefined
const listeners = new Set<() => void>()
function request(name: string | undefined) {
  requestedBeforePanelMount = name
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function useSecrets() {
  const system = useSystem()
  const secretDeclarationDependencies = system?.extensions.map((extension) => [
    extension.name,
    extension.enabled,
    extension.server?.secrets,
  ])
  const secrets = useAction(ListAction, null, {
    onError: keepLast,
    on: secretDeclarationDependencies,
  })
  useEvent('secrets:changed', () => void secrets.refetch())
  return secrets
}

const missing = (secrets: readonly Secret[] | undefined) =>
  secrets?.filter((secret) => !secret.set && !secret.via && secret.declaredBy.length > 0) ?? []

const validName = /^[A-Z][A-Z0-9_]*$/

const dot = (tone: string) => <span className={cn('size-1.5 shrink-0 rounded-full', tone)} />
const small = 'h-7 gap-1.5 px-2 font-mono text-[11.5px]'

function Heading({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 section-label">
      {children}
      {meta !== undefined && <span className="ml-auto flex items-center gap-1.5">{meta}</span>}
    </div>
  )
}

const field =
  'h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-[12px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40'

function ValueInput({
  name: fixed,
  replacing,
  taken = [],
  onDone,
}: {
  name?: string
  replacing: boolean
  taken?: readonly string[]
  onDone: () => void
}) {
  const [typed, setTyped] = useState('')
  const [value, setValue] = useState('')
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => {
    first.current?.focus({ preventScroll: true })
    first.current?.scrollIntoView({ block: 'nearest' })
  }, [])
  const name = fixed ?? typed
  const nameError =
    fixed || !typed
      ? undefined
      : !validName.test(typed)
        ? 'Start with a letter; use only A–Z, 0–9 and _'
        : taken.includes(typed)
          ? `${typed} is already listed; use its Replace`
          : undefined
  const ready = !!value.trim() && !!name && !nameError && !busy
  const save = async () => {
    if (!ready) return
    setBusy(true)
    setError(undefined)
    try {
      await api.action(SetAction, { name, value: value.trim() })
      setValue('')
      events.emit('secrets:changed', { name })
      onDone()
    } catch (failure) {
      setError(errorMessage(failure))
      setBusy(false)
    }
  }
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      void save()
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onDone()
    }
  }
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {!fixed && (
        <input
          aria-invalid={!!nameError}
          aria-label="Name of the new secret"
          autoComplete="off"
          className={cn(field, 'flex-none', nameError && 'border-error')}
          disabled={busy}
          onChange={(event) => setTyped(event.target.value.toUpperCase())}
          onKeyDown={keys}
          placeholder="MY_API_KEY"
          ref={first}
          spellCheck={false}
          value={typed}
        />
      )}
      {nameError && <p className="font-mono text-[11px] leading-snug text-error">{nameError}</p>}
      <div className="flex items-center gap-1.5">
        <input
          aria-label={fixed ? `${replacing ? 'New value' : 'Value'} for ${fixed}` : 'Value'}
          autoComplete="one-time-code"
          className={field}
          data-1p-ignore
          data-bwignore
          data-lpignore="true"
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={keys}
          placeholder={replacing ? 'Paste the new value' : 'Paste the value'}
          ref={fixed ? first : undefined}
          spellCheck={false}
          type={shown ? 'text' : 'password'}
          value={value}
        />
        <Button
          aria-label={shown ? 'Hide value' : 'Show value'}
          aria-pressed={shown}
          className="size-7 text-muted-foreground"
          onClick={() => setShown(!shown)}
          size="icon-sm"
          title={shown ? 'Hide value' : 'Show value'}
          type="button"
          variant="ghost"
        >
          {shown ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
        </Button>
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          className={small}
          disabled={!ready}
          onClick={() => void save()}
          size="sm"
          type="button"
        >
          {busy && <LoaderCircleIcon className="size-3.5 animate-spin" />}
          Save
        </Button>
        <Button className={small} onClick={onDone} size="sm" type="button" variant="ghost">
          Cancel
        </Button>
      </div>
      {error && <p className="font-mono text-[11px] leading-snug text-error">{error}</p>}
    </div>
  )
}

function ConfirmDelete({ name, onDone }: { name: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const safeCancelFocus = useRef<HTMLButtonElement>(null)
  useEffect(() => safeCancelFocus.current?.focus({ preventScroll: true }), [])
  const remove = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await api.action(DeleteAction, { name })
      events.emit('secrets:changed', { name })
      onDone()
    } catch (failure) {
      setError(errorMessage(failure))
      setBusy(false)
    }
  }
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 text-[12px] text-foreground/90">Delete this secret?</span>
        <Button
          className={small}
          disabled={busy}
          onClick={() => void remove()}
          size="sm"
          type="button"
          variant="destructive"
        >
          {busy && <LoaderCircleIcon className="size-3.5 animate-spin" />}
          Delete
        </Button>
        <Button
          className={small}
          onClick={onDone}
          ref={safeCancelFocus}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
      </div>
      {error && <p className="font-mono text-[11px] leading-snug text-error">{error}</p>}
    </div>
  )
}

type Mode = { name: string; mode: 'edit' | 'delete' }

function Row({
  secret,
  now,
  mode,
  onMode,
}: {
  secret: Secret
  now: number
  mode?: Mode['mode']
  onMode: (mode: Mode['mode'] | undefined) => void
}) {
  const needed = secret.declaredBy.length > 0
  const rowFocusAfterEditorCloses = useRef<HTMLButtonElement>(null)
  const was = useRef(mode)
  useEffect(() => {
    if (was.current && !mode && document.activeElement === document.body)
      rowFocusAfterEditorCloses.current?.focus({ preventScroll: true })
    was.current = mode
  }, [mode])
  return (
    <li aria-label={secret.name} className="px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-foreground">
          {secret.name}
        </span>
        {secret.set ? (
          <span
            className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground"
            title={secret.updatedAt && new Date(secret.updatedAt).toLocaleString()}
          >
            {dot('bg-success')}
            {secret.updatedAt
              ? `set · ${formatAgo(Date.parse(secret.updatedAt), now, { ago: true })}`
              : 'set'}
          </span>
        ) : secret.via ? (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            {dot('bg-success')}
            via {secret.via}
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-warning">
            {dot('bg-warning')}
            missing
          </span>
        )}
      </div>
      {secret.description && (
        <p className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
          {secret.description}
        </p>
      )}
      <div className="mt-1 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/75">
          {needed ? `needed by ${secret.declaredBy.join(', ')}` : 'no enabled extension needs it'}
        </span>
        {secret.url && (
          <a
            className="inline-flex shrink-0 items-center gap-1 text-[12px] text-brand outline-none hover:underline focus-visible:underline"
            href={secret.url}
            rel="noreferrer"
            target="_blank"
          >
            Get a key
            <ExternalLinkIcon className="size-3" />
          </a>
        )}
      </div>
      {mode === 'edit' ? (
        <ValueInput name={secret.name} onDone={() => onMode(undefined)} replacing={secret.set} />
      ) : mode === 'delete' ? (
        <ConfirmDelete name={secret.name} onDone={() => onMode(undefined)} />
      ) : (
        <div className="mt-2 flex items-center gap-1.5">
          <Button
            className={small}
            onClick={() => onMode('edit')}
            ref={rowFocusAfterEditorCloses}
            size="sm"
            type="button"
            variant="outline"
          >
            {secret.set ? 'Replace' : 'Add'}
          </Button>
          {secret.set && (
            <Button
              className={cn(small, 'text-muted-foreground hover:text-error')}
              onClick={() => onMode('delete')}
              size="sm"
              type="button"
              variant="ghost"
            >
              Delete
            </Button>
          )}
        </div>
      )}
    </li>
  )
}

function SecretsPanel() {
  const { data, error, loading } = useSecrets()
  const now = useNow(30000)
  type SingleOpenSecretEditor = Mode | 'add'
  const [open, setOpen] = useState<SingleOpenSecretEditor>()
  const row = open === 'add' ? undefined : open
  const target = useSyncExternalStore(subscribe, () => requestedBeforePanelMount)
  useEffect(() => {
    if (!target || !data || loading) return
    request(undefined)
    if (data.some((secret) => secret.name === target)) setOpen({ name: target, mode: 'edit' })
  }, [target, data, loading])
  const absent = missing(data).length
  const meta =
    loading && !data ? (
      <LoaderCircleIcon className="size-3 animate-spin" />
    ) : absent > 0 ? (
      <span className="flex items-center gap-1.5 text-warning">
        {dot('bg-warning')}
        {absent} missing
      </span>
    ) : data?.length ? (
      <span className="text-muted-foreground/70">all set</span>
    ) : undefined
  return (
    <section className="pt-3 pb-3.5">
      <Heading
        meta={
          <>
            {meta}
            {data && (
              <Button
                aria-label="Add a secret"
                aria-pressed={open === 'add'}
                className="-my-1 -mr-1.5 size-6 text-muted-foreground"
                onClick={() => setOpen(open === 'add' ? undefined : 'add')}
                size="icon-sm"
                title="Add a secret"
                type="button"
                variant="ghost"
              >
                <PlusIcon className="size-3.5" />
              </Button>
            )}
          </>
        }
      >
        Secrets
      </Heading>
      {data && open === 'add' && (
        <div className="px-3 pb-2.5">
          <ValueInput
            onDone={() => setOpen(undefined)}
            replacing={false}
            taken={data.map((secret) => secret.name)}
          />
        </div>
      )}
      {error && (
        <p className="mx-3 mt-2.5 font-mono text-[11px] leading-snug break-words text-error">
          {errorMessage(error)}
        </p>
      )}
      {data && data.length === 0 && (
        <p className="mx-3 mt-2.5 text-[12.5px] text-muted-foreground">
          No enabled extension needs a secret.
        </p>
      )}
      {data && data.length > 0 && (
        <ul className="mt-2 divide-y divide-border/70 border-y border-border/70">
          {data.map((secret) => (
            <Row
              key={secret.name}
              mode={row?.name === secret.name ? row.mode : undefined}
              now={now}
              onMode={(mode) => setOpen(mode ? { name: secret.name, mode } : undefined)}
              secret={secret}
            />
          ))}
        </ul>
      )}
      <p className="mx-3 mt-3 text-[11.5px] leading-snug text-muted-foreground/80">
        Plain text in <span className="font-mono">~/.ultimate/secrets.json</span>, readable only by
        your user, shared by every project.
      </p>
    </section>
  )
}

function Opener() {
  const ui = useUltimate()
  useEvent('secrets:open', (data) => {
    const name = (data as { name?: unknown } | undefined)?.name
    request(typeof name === 'string' ? name : undefined)
    ui.openPanel('secrets')
  })
  return null
}

export default defineWebExtension({
  slots: { overlay: [Opener] },
  panels: [
    {
      id: 'secrets',
      title: 'Secrets',
      icon: KeyRoundIcon,
      component: SecretsPanel,
      order: 9,
      tab: false,
    },
  ],
  commands: [
    {
      id: 'secrets.panel',
      title: 'Secrets…',
      run: (context) => context.openPanel('secrets'),
    },
  ],
})
