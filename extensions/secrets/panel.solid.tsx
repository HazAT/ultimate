/** @jsxImportSource @solidjs/web */
import { ExternalLink, LoaderCircle, Plus } from '@lucide/solid'
import {
  createEffect,
  createRoot,
  createSignal,
  For,
  Match,
  onSettled,
  Show,
  Switch,
} from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Input, SecretInput } from '@/components/ui/input.solid.tsx'
import {
  ROOT,
  api,
  cn,
  errorMessage,
  events,
  formatAgo,
  keepLast,
  openPanel,
  useAction,
  useEvent,
  useNow,
  useSystem,
} from '@/sdk/solid'
import { DeleteAction, ListAction, SetAction } from './refs.ts'
import type { Secret } from './refs.ts'

const [requested, setRequested] = createRoot(() => createSignal<string>())

export function Opener() {
  useEvent('secrets:open', (data) => {
    const name = (data as { name?: unknown } | undefined)?.name
    setRequested(typeof name === 'string' ? name : undefined)
    openPanel('secrets')
  })
  return null
}

type RowEditor = { kind: 'edit' | 'delete'; name: string }
type OpenEditor = { kind: 'add' } | RowEditor

const validName = /^[A-Z][A-Z0-9_]*$/
const small = 'h-7 gap-1.5 px-2 font-mono text-[11.5px]'
const dot = 'size-1.5 shrink-0 rounded-full'
const inlineError = 'font-mono text-[11px] leading-snug text-error'

function Editor(props: {
  open: OpenEditor
  replacing?: boolean
  listed?: readonly Secret[]
  close: () => void
}) {
  const [typed, setTyped] = createSignal('')
  const [value, setValue] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const adding = () => props.open.kind === 'add'
  const deleting = () => props.open.kind === 'delete'
  const name = () => (props.open.kind === 'add' ? typed() : props.open.name)
  const nameError = () => {
    if (!adding() || !typed()) return undefined
    if (!validName.test(typed())) return 'Start with a letter; use only A–Z, 0–9 and _'
    if (props.listed?.some((secret) => secret.name === typed()))
      return `${typed()} is already listed; use its Replace`
    return undefined
  }
  const ready = () => !busy() && (deleting() || (!!name() && !nameError() && !!value().trim()))

  let editor: HTMLDivElement | undefined
  let cancel: HTMLButtonElement | undefined
  onSettled(() => {
    const field = editor?.querySelector('input')
    ;(field ?? cancel)?.focus({ preventScroll: true })
    field?.scrollIntoView({ block: 'nearest' })
  })

  async function commit() {
    if (!ready()) return
    const target = name()
    setBusy(true)
    setError(undefined)
    try {
      if (deleting()) await api.action(DeleteAction, { name: target })
      else await api.action(SetAction, { name: target, value: value().trim() })
      setValue('')
      events.emit('secrets:changed', { name: target })
      props.close()
    } catch (failure) {
      setError(errorMessage(failure))
      setBusy(false)
    }
  }

  function keys(event: KeyboardEvent) {
    if (event.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      void commit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      props.close()
    }
  }

  return (
    <div
      class="mt-2 flex flex-col gap-1.5"
      ref={(element) => {
        editor = element
      }}
    >
      <Show when={!deleting()}>
        <Show when={adding()}>
          <Input
            aria-invalid={nameError() ? 'true' : 'false'}
            aria-label="Name of the new secret"
            disabled={busy()}
            onKeyDown={keys}
            onValueChange={(next) => setTyped(next.toUpperCase())}
            placeholder="MY_API_KEY"
            value={typed()}
          />
          <Show when={nameError()}>
            <p class={inlineError}>{nameError()}</p>
          </Show>
        </Show>
        <SecretInput
          aria-label={
            adding() ? 'Value' : `${props.replacing ? 'New value' : 'Value'} for ${name()}`
          }
          class="gap-1.5"
          disabled={busy()}
          onKeyDown={keys}
          onValueChange={setValue}
          placeholder={props.replacing ? 'Paste the new value' : 'Paste the value'}
          value={value()}
        />
      </Show>
      <div class="flex items-center gap-1.5">
        <Show when={deleting()}>
          <span class="min-w-0 flex-1 text-[12px] text-foreground/90">Delete this secret?</span>
        </Show>
        <Button
          aria-label={
            deleting()
              ? `Confirm delete for ${name()}`
              : adding()
                ? 'Save new secret'
                : `Save secret ${name()}`
          }
          class={small}
          data-agent-confirm={
            deleting()
              ? 'Deletes the stored secret'
              : props.replacing
                ? 'Replaces the stored secret'
                : undefined
          }
          disabled={!ready()}
          onClick={commit}
          size="sm"
          variant={deleting() ? 'destructive' : 'default'}
        >
          <Show when={busy()}>
            <LoaderCircle class="size-3.5 animate-spin" />
          </Show>
          {deleting() ? 'Delete' : 'Save'}
        </Button>
        <Button
          aria-label={
            deleting()
              ? `Cancel removal of ${name()}`
              : adding()
                ? 'Cancel adding a secret'
                : `Cancel editing ${name()}`
          }
          class={small}
          onClick={() => props.close()}
          ref={(element) => {
            cancel = element
          }}
          size="sm"
          variant="ghost"
        >
          Cancel
        </Button>
      </div>
      <Show when={error()}>
        <p class={inlineError}>{error()}</p>
      </Show>
    </div>
  )
}

function SecretRow(props: {
  secret: Secret
  now: number
  editor?: RowEditor
  show: (editor: RowEditor) => void
  close: (editor: RowEditor) => void
}) {
  const present = () => !!(props.secret.set || props.secret.via)
  const status = () => {
    const { set, via, updatedAt } = props.secret
    if (set)
      return updatedAt
        ? `set · ${formatAgo(Date.parse(updatedAt), props.now, { ago: true })}`
        : 'set'
    return via ? `via ${via}` : 'missing'
  }

  let editButton: HTMLButtonElement | undefined
  createEffect(
    () => !!props.editor,
    (editing, wasEditing) => {
      if (!editing && wasEditing && document.activeElement === document.body)
        editButton?.focus({ preventScroll: true })
    },
  )

  return (
    <li aria-label={props.secret.name} class="px-3 py-2.5">
      <div class="flex items-center gap-2">
        <span class="min-w-0 flex-1 truncate font-mono text-[12.5px] text-foreground">
          {props.secret.name}
        </span>
        <span
          class={cn(
            'flex shrink-0 items-center gap-1.5 font-mono text-[11px]',
            present() ? 'text-muted-foreground' : 'text-warning',
          )}
          title={
            props.secret.set && props.secret.updatedAt
              ? new Date(props.secret.updatedAt).toLocaleString()
              : undefined
          }
        >
          <span class={cn(dot, present() ? 'bg-success' : 'bg-warning')} />
          {status()}
        </span>
      </div>
      <Show when={props.secret.description}>
        <p class="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
          {props.secret.description}
        </p>
      </Show>
      <div class="mt-1 flex items-center gap-2">
        <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/75">
          {props.secret.declaredBy.length
            ? `needed by ${props.secret.declaredBy.join(', ')}`
            : 'no enabled extension needs it'}
        </span>
        <Show when={props.secret.url}>
          {(url) => (
            <Button
              aria-label={`Get a key for ${props.secret.name}`}
              class="h-auto gap-1 rounded-none p-0 text-[12px] font-normal text-brand focus-visible:border-transparent focus-visible:underline focus-visible:ring-0 has-[>svg]:px-0"
              render={(link) => (
                <a {...link} href={url()} rel="noreferrer" target="_blank">
                  Get a key <ExternalLink class="size-3" />
                </a>
              )}
              variant="link"
            />
          )}
        </Show>
      </div>
      <Show
        when={props.editor}
        keyed
        fallback={
          <div class="mt-2 flex items-center gap-1.5">
            <Button
              aria-label={`${props.secret.set ? 'Replace' : 'Add'} ${props.secret.name}`}
              class={small}
              onClick={() => props.show({ kind: 'edit', name: props.secret.name })}
              ref={(element) => {
                editButton = element
              }}
              size="sm"
              variant="outline"
            >
              {props.secret.set ? 'Replace' : 'Add'}
            </Button>
            <Show when={props.secret.set}>
              <Button
                aria-label={`Delete ${props.secret.name}`}
                class={cn(small, 'text-muted-foreground hover:text-error')}
                onClick={() => props.show({ kind: 'delete', name: props.secret.name })}
                size="sm"
                variant="ghost"
              >
                Delete
              </Button>
            </Show>
          </div>
        }
      >
        {(editor) => (
          <Editor open={editor} replacing={props.secret.set} close={() => props.close(editor)} />
        )}
      </Show>
    </li>
  )
}

export function SecretsPanel() {
  const system = useSystem()
  const { data, error, loading, refetch } = useAction(ListAction, null, {
    conversation: ROOT,
    onError: keepLast,
    on: () =>
      system()?.extensions.map(({ name, enabled, server }) => [name, enabled, server?.secrets]),
  })
  useEvent('secrets:changed', () => void refetch())
  const now = useNow(30_000)
  const [open, setOpen] = createSignal<OpenEditor>()
  const adding = () => (open()?.kind === 'add' ? open() : undefined)
  const missing = () =>
    data()?.filter((secret) => !secret.set && !secret.via && secret.declaredBy.length).length ?? 0

  function editorFor(name: string) {
    const editor = open()
    return editor && editor.kind !== 'add' && editor.name === name ? editor : undefined
  }

  function close(editor: OpenEditor) {
    setOpen((current) => (current === editor ? undefined : current))
  }

  createEffect(
    () => ({ target: requested(), rows: data(), waiting: loading(), current: open() }),
    ({ target, rows, waiting, current }) => {
      if (!target || !rows || waiting) return
      setRequested(undefined)
      const alreadyEditing = current?.kind === 'edit' && current.name === target
      if (!alreadyEditing && rows.some((secret) => secret.name === target))
        setOpen({ kind: 'edit', name: target })
    },
  )

  return (
    <section class="pt-3 pb-3.5">
      <div class="flex items-center gap-2 px-3 section-label">
        Secrets
        <span class="ml-auto flex items-center gap-1.5">
          <Switch>
            <Match when={loading() && !data()}>
              <LoaderCircle class="size-3 animate-spin" />
            </Match>
            <Match when={missing() > 0}>
              <span class="flex items-center gap-1.5 text-warning">
                <span class={cn(dot, 'bg-warning')} />
                {missing()} missing
              </span>
            </Match>
            <Match when={data()?.length}>
              <span class="text-muted-foreground/70">all set</span>
            </Match>
          </Switch>
          <Show when={data()}>
            <Button
              aria-label="Add a secret"
              aria-pressed={adding() ? 'true' : 'false'}
              class="-my-1 -mr-1.5 size-6 text-muted-foreground"
              onClick={() => {
                setOpen(adding() ? undefined : { kind: 'add' })
              }}
              size="icon-sm"
              title="Add a secret"
              variant="ghost"
            >
              <Plus class="size-3.5" />
            </Button>
          </Show>
        </span>
      </div>
      <Show when={adding()} keyed>
        {(editor) => (
          <div class="px-3 pb-2.5">
            <Editor open={editor} listed={data()} close={() => close(editor)} />
          </div>
        )}
      </Show>
      <Show when={error()}>
        {(failure) => (
          <p class={cn('mx-3 mt-2.5 break-words', inlineError)}>{errorMessage(failure())}</p>
        )}
      </Show>
      <Show when={data()}>
        {(rows) => (
          <Show
            when={rows().length}
            fallback={
              <p class="mx-3 mt-2.5 text-[12.5px] text-muted-foreground">
                No enabled extension needs a secret.
              </p>
            }
          >
            <ul class="mt-2 divide-y divide-border/70 border-y border-border/70">
              <For each={rows()} keyed={(secret) => secret.name}>
                {(secret) => (
                  <SecretRow
                    secret={secret()}
                    now={now()}
                    editor={editorFor(secret().name)}
                    show={setOpen}
                    close={close}
                  />
                )}
              </For>
            </ul>
          </Show>
        )}
      </Show>
      <p class="mx-3 mt-3 text-[11.5px] leading-snug text-muted-foreground/80">
        Plain text in <span class="font-mono">~/.ultimate/secrets.json</span>, readable only by your
        user, shared by every project.
      </p>
    </section>
  )
}
