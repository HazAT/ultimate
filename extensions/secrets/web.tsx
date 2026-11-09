import { ExternalLinkIcon, EyeIcon, EyeOffIcon, KeyRoundIcon, LoaderCircleIcon } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  api,
  cn,
  defineWebExtension,
  errorMessage,
  events,
  formatAgo,
  useAction,
  useEvent,
  useNow,
  useSystem,
  useUltimate,
} from '@/sdk'
import { DeleteAction, ListAction, SetAction } from './refs.ts'
import type { Secret } from './refs.ts'

/** One row of the `list` action: a declared or stored secret, never its value. */
/**
 * The row another facet asked for with `secrets:open { name }`, until the panel opens it. Kept outside React: the
 * panel mounts only once the request has opened it.
 */
let requested: string | undefined
const listeners = new Set<() => void>()
function request(name: string | undefined) {
  requested = name
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The list, read on mount, after a save or delete here, and when an extension is enabled, disabled or changes its
 * declared secrets. A hot reload of server code alone (`loadedAt`) is left out: it changes nothing the list shows,
 * and re-reading on it sent a burst of reads from every tab on each save.
 */
function useSecrets() {
  const system = useSystem()
  // Failures show inline in the panel, not as notices: the status line reads the list on every page.
  const secrets = useAction(ListAction, null, {
    onError: () => {},
    on: system?.extensions.map((extension) => [
      extension.name,
      extension.enabled,
      extension.server?.secrets,
    ]),
  })
  useEvent('secrets:changed', () => void secrets.refetch())
  return secrets
}

const missing = (secrets: readonly Secret[] | undefined) =>
  secrets?.filter((secret) => !secret.set && !secret.via && secret.declaredBy.length > 0) ?? []

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

/**
 * The value, typed or pasted, hidden unless shown. It lives only in this component and is cleared after a save. No
 * <form> and a one-time-code field, as in the models login: browsers must not offer to save a key as a password.
 */
function ValueInput({
  name,
  replacing,
  onDone,
}: {
  name: string
  replacing: boolean
  onDone: () => void
}) {
  const [value, setValue] = useState('')
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    field.current?.focus({ preventScroll: true })
    field.current?.scrollIntoView({ block: 'nearest' })
  }, [])
  const save = async () => {
    if (!value.trim() || busy) return
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
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <input
          aria-label={`${replacing ? 'New value' : 'Value'} for ${name}`}
          autoComplete="one-time-code"
          className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-[12px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
          data-1p-ignore
          data-bwignore
          data-lpignore="true"
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') {
              event.preventDefault()
              // oxlint-disable-next-line typescript/no-floating-promises -- save catches secret write failures and displays them with setError.
              void save()
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              onDone()
            }
          }}
          placeholder={replacing ? 'Paste the new value' : 'Paste the value'}
          ref={field}
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
          disabled={!value.trim() || busy}
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
  // Focus starts on Cancel, so a stray Enter keeps the secret.
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => cancel.current?.focus({ preventScroll: true }), [])
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
          ref={cancel}
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
  // When the form or the confirmation closes, focus returns to the row instead of the page.
  const primary = useRef<HTMLButtonElement>(null)
  const was = useRef(mode)
  useEffect(() => {
    if (was.current && !mode && document.activeElement === document.body)
      primary.current?.focus({ preventScroll: true })
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
            ref={primary}
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
  const [open, setOpen] = useState<Mode>()
  // A row another facet asked for opens for editing once the list has it.
  const target = useSyncExternalStore(subscribe, () => requested)
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
      <Heading meta={meta}>Secrets</Heading>
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
              mode={open?.name === secret.name ? open.mode : undefined}
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

/** Other facets open the panel at a row with `events.emit('secrets:open', { name })`. */
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
    // Opened from ⌘K and missing-secret prompts.
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
