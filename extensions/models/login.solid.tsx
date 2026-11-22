import {
  ArrowLeft,
  Check,
  CircleAlert,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  LogOut,
  Search,
} from '@lucide/solid'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onSettled,
  Show,
  Switch,
} from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { CopyValue } from '@/components/ui/copy-value.solid.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog.solid.tsx'
import { Form } from '@/components/ui/form.solid.tsx'
import { Input, SecretInput } from '@/components/ui/input.solid.tsx'
import {
  api,
  cn,
  errorMessage,
  refreshModels,
  ROOT,
  useConversationId,
  useDialog,
  useDocOf,
  useExternal,
  useModels,
  useNow,
  writingAs,
} from '@/sdk/solid'
import type { AuthEvent, AuthPrompt } from '@/sdk/solid'
import type { ConversationId } from '@earendil-works/pi-durable'
import { meansNone } from '../../lib/errors.ts'
import { AnswerAction, CancelAction, LoginAction, LoginDoc, LogoutAction } from './refs.ts'
import { authLabel, dialogs, loginProvider, pickerTarget, termsOf } from './state.ts'
import type { ProviderInfo } from './state.ts'

type Method = {
  provider: ProviderInfo
  type: ProviderInfo['authTypes'][number]['type']
  name: string
}
const methodKey = (method: Method) => `${method.provider.id}:${method.type}`
const typeLabel = (method: Method) => (method.type === 'api_key' ? 'API key' : 'OAuth')
const small = 'h-7 text-[12px]'

export function LoginDialog() {
  const [open, setOpen] = useDialog(dialogs.login)
  const [, setPicker] = useDialog(dialogs.picker)
  let cancelAttempt: Attempt['cancel'] | undefined
  onSettled(() => {
    const reload = () => void refreshModels()
    addEventListener('focus', reload)
    return () => removeEventListener('focus', reload)
  })
  return (
    <Dialog
      open={open()}
      onOpenChange={(next, details) => {
        if (!next) cancelAttempt?.(details.source)
        setOpen(next)
      }}
    >
      <DialogContent
        class="top-[16%] translate-y-0 grid-cols-[minmax(0,1fr)] gap-0 overflow-hidden p-0 font-mono sm:max-w-xl"
        showCloseButton={false}
      >
        <DialogTitle class="sr-only">Log in to a provider</DialogTitle>
        <DialogDescription class="sr-only">
          Choose a subscription or API key login; credentials are shared with pi.
        </DialogDescription>
        <Show when={open()}>
          <LoginSession
            onAttempt={(attempt) => {
              cancelAttempt = attempt?.cancel
            }}
            close={() => setOpen(false)}
            pick={() => {
              setOpen(false)
              setPicker(true)
            }}
          />
        </Show>
      </DialogContent>
    </Dialog>
  )
}

function beginLogin(method: Method, conversationId: ConversationId | undefined) {
  const lifetime = new AbortController()
  const [result, setResult] = createSignal<{ flowId?: string; error?: string }>()
  let flowId: string | undefined
  const cancel = (source = 'app') => lifetime.abort(source)
  const sendCancel = () =>
    flowId &&
    writingAs(lifetime.signal.reason, () =>
      api
        .action(CancelAction, { flowId: flowId! }, { conversationId, keepalive: true })
        .catch(meansNone),
    )
  addEventListener('pagehide', () => cancel(), { signal: lifetime.signal })
  lifetime.signal.addEventListener('abort', () => void sendCancel(), { once: true })
  const finish = () => {
    flowId = undefined
    cancel()
  }
  async function start() {
    try {
      const next = await api.action(
        LoginAction,
        { provider: method.provider.id, type: method.type },
        { conversationId },
      )
      flowId = next.flowId
      if (lifetime.signal.aborted) await sendCancel()
      else setResult(next)
    } catch (failure) {
      if (!lifetime.signal.aborted) setResult({ error: errorMessage(failure) })
      finish()
    }
  }
  void start()
  return { method, conversationId, result, cancel, finish }
}

type Attempt = ReturnType<typeof beginLogin>

function LoginSession(props: {
  close: () => void
  pick: () => void
  onAttempt: (attempt: Attempt | undefined) => void
}) {
  const shown = useConversationId()
  const requested = useExternal(loginProvider.get, loginProvider.subscribe)
  const [attempt, setAttempt] = createSignal<Attempt>()
  let active: Attempt | undefined
  function start(method: Method) {
    active?.cancel()
    active = beginLogin(method, pickerTarget.get() ?? shown())
    props.onAttempt(active)
    setAttempt(active)
  }
  createEffect(shown, (id, previous) => {
    if (id !== previous && active) props.close()
  })
  onSettled(() => () => {
    active?.cancel()
    props.onAttempt(undefined)
  })
  return (
    <Show
      when={attempt()}
      keyed
      fallback={<Chooser initialQuery={requested() ?? ''} choose={start} />}
    >
      {(current) => (
        <FlowView
          attempt={current}
          back={() => {
            active = undefined
            props.onAttempt(undefined)
            setAttempt(undefined)
          }}
          close={props.close}
          pick={props.pick}
          retry={() => start(current.method)}
        />
      )}
    </Show>
  )
}

const statuses = {
  running: ['in progress', 'text-brand'],
  complete: ['logged in', 'text-success'],
  cancel: ['cancelled', 'text-muted-foreground'],
  error: ['failed', 'text-error'],
} as const

function FlowView(props: {
  attempt: Attempt
  back: () => void
  close: () => void
  pick: () => void
  retry: () => void
}) {
  const doc = useDocOf(() => ROOT, LoginDoc)
  const id = () => props.attempt.result()?.flowId
  const flow = () => (id() ? doc()?.flows[id()!] : undefined)
  const failure = () => props.attempt.result()?.error ?? flow()?.error
  const status = createMemo(() => (failure() ? 'error' : (flow()?.status ?? 'running')))
  const promptKey = createMemo(() =>
    status() === 'running' && flow()?.prompt ? JSON.stringify(flow()?.prompt) : undefined,
  )
  createEffect(status, (next) => {
    if (next !== 'running') props.attempt.finish()
    if (next === 'complete') void refreshModels()
  })
  return (
    <div class="flex flex-col">
      <div class="flex items-center gap-2 border-b border-border/70 px-3 py-2.5">
        <Button
          aria-label="Back to providers"
          class="size-6 text-muted-foreground"
          disabled={status() === 'running'}
          onClick={() => props.back()}
          size="icon"
          variant="ghost"
        >
          <ArrowLeft class="size-3.5" />
        </Button>
        <span class="truncate text-[13px] text-foreground">{props.attempt.method.name}</span>
        <span class="text-[11px] text-muted-foreground">{typeLabel(props.attempt.method)}</span>
        <span class={cn('ml-auto flex items-center gap-1.5 text-[11.5px]', statuses[status()][1])}>
          {status() === 'running' && <LoaderCircle class="size-3 animate-spin" />}
          {promptKey() ? 'waiting for you' : statuses[status()][0]}
        </span>
      </div>
      <div class="flex max-h-[60vh] flex-col gap-4 overflow-y-auto px-4 py-4">
        <For each={flow()?.events ?? []} keyed={false}>
          {(event) => <EventView event={event()} />}
        </For>
        <Show when={promptKey()} keyed>
          {(_key) => (
            <PromptForm
              flowId={id()!}
              conversationId={props.attempt.conversationId}
              prompt={flow()!.prompt!}
            />
          )}
        </Show>
        <Switch>
          <Match when={status() === 'running' && !promptKey() && !flow()?.events.length}>
            <p class="text-[12px] text-muted-foreground">
              Starting {props.attempt.method.provider.id} login…
            </p>
          </Match>
          <Match when={status() === 'complete'}>
            <p class="flex items-center gap-2 font-sans text-[13px] text-success">
              <Check class="size-4" /> Logged in to {props.attempt.method.provider.name}. Its models
              are available now.
            </p>
          </Match>
          <Match when={status() === 'error'}>
            <p class="flex items-start gap-2 font-sans text-[13px] text-error">
              <CircleAlert class="mt-0.5 size-4 shrink-0" /> {failure() ?? 'Login failed'}
            </p>
          </Match>
          <Match when={status() === 'cancel'}>
            <p class="text-[12px] text-muted-foreground">Login cancelled.</p>
          </Match>
        </Switch>
      </div>
      <div class="flex items-center justify-end gap-2 border-t border-border/70 px-3 py-2.5">
        <Switch>
          <Match when={status() === 'running' && id()}>
            <Button
              class={small}
              onClick={(_, details) => props.attempt.cancel(details.source)}
              size="sm"
              variant="ghost"
            >
              Cancel login
            </Button>
          </Match>
          <Match when={status() === 'error' || status() === 'cancel'}>
            <Button class={small} onClick={() => props.retry()} size="sm" variant="outline">
              Try again
            </Button>
          </Match>
          <Match when={status() === 'complete'}>
            <Button class={small} onClick={() => props.pick()} size="sm" variant="outline">
              Pick a model
            </Button>
            <Button class={small} onClick={() => props.close()} size="sm">
              Done
            </Button>
          </Match>
        </Switch>
      </div>
    </div>
  )
}

function PromptForm(props: {
  flowId: string
  conversationId?: ConversationId
  prompt: AuthPrompt
}) {
  const [value, setValue] = createSignal('')
  const [error, setError] = createSignal<string>()
  const [answered, setAnswered] = createSignal(false)
  const canSubmit = () => props.prompt.type === 'text' || !!value().trim()
  let form: HTMLFormElement | undefined
  onSettled(() => {
    form?.querySelector('input')?.focus()
  })

  async function answer(text: string) {
    if (answered()) return
    setAnswered(true)
    setError(undefined)
    try {
      await api.action(
        AnswerAction,
        { flowId: props.flowId, value: text },
        { conversationId: props.conversationId },
      )
    } catch (failure) {
      setAnswered(false)
      setError(errorMessage(failure))
    }
  }

  return (
    <Form
      class="flex flex-col gap-1.5"
      ref={(element) => {
        form = element
      }}
    >
      <p class="font-sans text-[13px] text-foreground/90">{props.prompt.message}</p>
      <Show
        when={props.prompt.type === 'select' && props.prompt.options}
        fallback={
          <div class="flex gap-2">
            <Show
              when={props.prompt.type === 'secret'}
              fallback={
                <Input
                  aria-label={props.prompt.message}
                  class="h-8 flex-1 bg-transparent px-2.5 text-[12.5px]"
                  placeholder={
                    'placeholder' in props.prompt
                      ? (props.prompt.placeholder ??
                        (props.prompt.type === 'manual_code' ? 'code or redirect URL' : ''))
                      : ''
                  }
                  value={value()}
                  onValueChange={setValue}
                  disabled={answered()}
                />
              }
            >
              <div
                class="flex min-w-0 flex-1 [&>[data-slot=password-input]]:w-full [&_input]:h-8 [&_input]:bg-transparent [&_input]:px-2.5 [&_input]:text-[12.5px]"
                data-agent-secret
              >
                <SecretInput
                  aria-label={props.prompt.message}
                  placeholder={'placeholder' in props.prompt ? props.prompt.placeholder : undefined}
                  value={value()}
                  onValueChange={setValue}
                  disabled={answered()}
                />
              </div>
            </Show>
            <Button
              class="h-8 px-3 text-[12px]"
              disabled={answered() || !canSubmit()}
              onClick={() => answer(value().trim())}
              type="submit"
            >
              Continue
            </Button>
          </div>
        }
      >
        {(options) => (
          <For each={options()} keyed={(option) => option.id}>
            {(option) => (
              <Button
                class="h-auto flex-col items-start border-border/80 px-2.5 py-1.5 text-left font-normal hover:border-brand/60 hover:bg-accent/50"
                disabled={answered()}
                onClick={() => answer(option().id)}
                variant="outline"
              >
                <span class="text-[12.5px] text-foreground">{option().label}</span>
                {option().description && (
                  <span class="font-sans text-[12px] text-muted-foreground">
                    {option().description}
                  </span>
                )}
              </Button>
            )}
          </For>
        )}
      </Show>
      <Show when={error()}>{(message) => <p class="text-[12px] text-error">{message()}</p>}</Show>
    </Form>
  )
}

function OpenUrl(props: { url: string; label: string }) {
  return (
    <Button
      class="h-7 gap-1.5 px-2 font-mono text-[11.5px]"
      size="sm"
      render={(button) => (
        <a {...button} href={props.url} rel="noreferrer" target="_blank">
          <ExternalLink class="size-3.5" /> {props.label}
        </a>
      )}
    />
  )
}

function EventView(props: { event: AuthEvent }) {
  return (
    <Switch>
      <Match when={props.event.type === 'info' && props.event}>
        {(event) => (
          <div class="flex flex-col gap-1.5">
            <p class="font-sans text-[13px] leading-snug text-foreground/90">{event().message}</p>
            <For each={event().links ?? []} keyed={(link) => link.url}>
              {(link) => (
                <a
                  class="flex items-center gap-1.5 text-[12px] text-brand hover:underline"
                  href={link().url}
                  rel="noreferrer"
                  target="_blank"
                >
                  <ExternalLink class="size-3" /> {link().label ?? link().url}
                </a>
              )}
            </For>
          </div>
        )}
      </Match>
      <Match when={props.event.type === 'auth_url' && props.event}>
        {(event) => (
          <div class="flex flex-col gap-2">
            <p class="font-sans text-[13px] text-foreground/90">
              Open this URL in your browser to sign in:
            </p>
            <div class="rounded-md border border-border/80 bg-terminal px-2.5 py-2 text-[11.5px] text-muted-foreground">
              <CopyValue field="sign-in URL" value={event().url}>
                <span class="line-clamp-3 break-all whitespace-normal">{event().url}</span>
              </CopyValue>
            </div>
            <div>
              <OpenUrl label="Open sign-in page" url={event().url} />
            </div>
            {event().instructions && (
              <p class="font-sans text-[12.5px] text-warning">{event().instructions}</p>
            )}
          </div>
        )}
      </Match>
      <Match when={props.event.type === 'device_code' && props.event}>
        {(event) => <DeviceCode event={event()} />}
      </Match>
      <Match when={props.event.type === 'progress' && props.event}>
        {(event) => <p class="text-[12px] text-muted-foreground">{event().message}</p>}
      </Match>
    </Switch>
  )
}

function DeviceCode(props: { event: Extract<AuthEvent, { type: 'device_code' }> }) {
  const since = Date.now()
  const now = useNow(1000, () => props.event.expiresInSeconds !== undefined)
  const seconds = () =>
    props.event.expiresInSeconds === undefined
      ? undefined
      : Math.max(0, props.event.expiresInSeconds - Math.floor((now() - since) / 1000))
  return (
    <div class="flex flex-col gap-2">
      <p class="font-sans text-[13px] text-foreground/90">
        Enter this code at{' '}
        <a
          class="text-brand hover:underline"
          href={props.event.verificationUri}
          rel="noreferrer"
          target="_blank"
        >
          {props.event.verificationUri}
        </a>
        :
      </p>
      <div class="flex items-center gap-3">
        <span class="rounded-md border border-border/80 bg-terminal px-3 py-1.5 text-[22px] font-semibold tracking-[0.25em] text-foreground">
          <CopyValue field="device code" value={props.event.userCode} />
        </span>
        <OpenUrl label="Open device verification" url={props.event.verificationUri} />
      </div>
      <Show when={seconds() !== undefined}>
        <p
          class={cn(
            'text-[11.5px] tabular-nums',
            seconds() === 0 ? 'text-error' : 'text-muted-foreground',
          )}
        >
          {seconds() === 0
            ? 'code expired'
            : `expires in ${Math.floor(seconds()! / 60)}:${String(seconds()! % 60).padStart(2, '0')}`}
        </p>
      </Show>
    </div>
  )
}

function Chooser(props: { initialQuery: string; choose: (method: Method) => void }) {
  const models = useModels()
  const [query, setQuery] = createSignal(() => props.initialQuery)
  const [busy, setBusy] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [confirm, setConfirm] = createSignal<string>()
  const methods = createMemo(() =>
    (models()?.providers ?? [])
      .flatMap((provider) =>
        provider.authTypes.map((auth) => ({ provider, type: auth.type, name: auth.name })),
      )
      .toSorted(
        (a, b) =>
          Number(b.provider.status.configured) - Number(a.provider.status.configured) ||
          Number(b.type === 'oauth') - Number(a.type === 'oauth') ||
          a.name.localeCompare(b.name),
      ),
  )
  const shown = createMemo(() => {
    const terms = termsOf(query())
    return methods().filter((method) =>
      terms.every((term) =>
        `${method.provider.id} ${method.name} ${typeLabel(method)}`.toLowerCase().includes(term),
      ),
    )
  })

  async function logout(provider: ProviderInfo) {
    setConfirm(undefined)
    setBusy(provider.id)
    setError(undefined)
    try {
      await api.action(LogoutAction, { provider: provider.id })
      void refreshModels()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(undefined)
    }
  }
  return (
    <Form class="flex flex-col">
      <div class="flex h-11 items-center gap-2 border-b border-border/70 px-3">
        <Search class="size-4 shrink-0 opacity-50" />
        <Input
          aria-label="Search login providers"
          autofocus
          class="h-full flex-1 rounded-none border-0 bg-transparent px-0 text-[13px] focus-visible:ring-0"
          onValueChange={setQuery}
          placeholder="Search providers…"
          value={query()}
        />
      </div>
      <div class="max-h-[55vh] overflow-y-auto p-1">
        <For
          each={shown()}
          keyed={methodKey}
          fallback={
            <p class="py-6 text-center text-[12px] text-muted-foreground">No provider matches.</p>
          }
        >
          {(method, index) => (
            <Show
              when={confirm() !== methodKey(method())}
              fallback={
                <div class="flex flex-col gap-2 rounded-sm border border-warning/40 bg-warning/8 px-2.5 py-2">
                  <p class="font-sans text-[12.5px] text-foreground/90">
                    Log out of {method().provider.name}? This also logs out <code>pi</code>: the
                    credential is removed from{' '}
                    <span class="font-mono text-[11.5px]">~/.pi/agent/auth.json</span>.
                  </p>
                  <div class="flex justify-end gap-2">
                    <Button
                      autofocus
                      class={small}
                      onClick={() => setConfirm(undefined)}
                      size="sm"
                      variant="ghost"
                    >
                      Keep login
                    </Button>
                    <Button
                      class={small}
                      data-agent-confirm={`Remove the stored ${method().provider.id} credential from Ultimate and pi.`}
                      onClick={() => logout(method().provider)}
                      size="sm"
                      variant="destructive"
                    >
                      <LogOut class="size-3" /> Confirm logout
                    </Button>
                  </div>
                </div>
              }
            >
              <div class="group/row flex items-center gap-2 rounded-sm pr-2 transition-colors hover:bg-accent/60">
                <Button
                  aria-label={`${method().name} (${typeLabel(method())}, ${method().provider.id})`}
                  class="min-w-0 flex-1 justify-start gap-2 px-2 py-1.5 text-left"
                  onClick={() => props.choose(method())}
                  type={index() === 0 ? 'submit' : 'button'}
                  size={null}
                  variant={null}
                >
                  <KeyRound
                    class={cn(
                      'size-3.5 shrink-0',
                      authLabel(method().provider) ? 'text-success' : 'text-muted-foreground/60',
                    )}
                  />
                  <span class="truncate text-[12.5px] text-foreground">{method().name}</span>
                  <span class="shrink-0 text-[11px] text-muted-foreground/70">
                    {typeLabel(method())}
                  </span>
                  <span class="shrink-0 text-[11px] text-muted-foreground/50">
                    {method().provider.id}
                  </span>
                </Button>
                <Show
                  when={authLabel(method().provider)}
                  fallback={
                    <span class="shrink-0 text-[11px] text-muted-foreground/50">
                      not configured
                    </span>
                  }
                >
                  {(label) => <span class="shrink-0 text-[11px] text-success/90">✓ {label()}</span>}
                </Show>
                <Show when={method().provider.status.source === 'stored'}>
                  <Button
                    aria-label={`Log out ${method().provider.id} (${typeLabel(method())})`}
                    class="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                    disabled={busy() === method().provider.id}
                    onClick={() => setConfirm(methodKey(method()))}
                    size="sm"
                    variant="ghost"
                  >
                    <LogOut class="size-3" /> log out
                  </Button>
                </Show>
              </div>
            </Show>
          )}
        </For>
      </div>
      <div class="flex items-center gap-2 border-t border-border/70 px-3 py-1.5 text-[11px] text-muted-foreground">
        <Show
          when={error()}
          fallback="Credentials are stored in ~/.pi/agent/auth.json, shared with pi."
        >
          {(message) => <span class="text-error">{message()}</span>}
        </Show>
      </div>
    </Form>
  )
}
