import {
  ArrowLeftIcon,
  CheckIcon,
  CircleAlertIcon,
  CopyIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  LogOutIcon,
  SearchIcon,
} from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  api,
  cn,
  errorMessage,
  refreshModels,
  useCopy,
  useDialog,
  useDoc,
  useModels,
  useNow,
  useUltimate,
} from '@/sdk'
import type { AuthEvent, AuthPrompt } from '@/sdk'
import { authLabel, dialogs, reopenPicker, useLoginProvider } from './state.tsx'
import type { ProviderInfo } from './state.tsx'
import { AnswerAction, CancelAction, LoginAction, LoginDoc, LogoutAction } from './refs.ts'

type AuthType = ProviderInfo['authTypes'][number]['type']
function useLoginFlow(flowId: string | undefined) {
  const flows = useDoc(LoginDoc)?.flows
  return flowId === undefined ? undefined : flows?.[flowId]
}
/** Cancel a running flow; it may have just ended, which needs no notice. */
const cancel = (flowId: string) =>
  // The flow may have just ended; a failed cancel needs no notice.
  api.action(CancelAction, { flowId }, { keepalive: true }).catch(() => undefined)
interface Method {
  provider: ProviderInfo
  type: AuthType
  name: string
}

const typeLabel = (method: Method) => (method.type === 'api_key' ? 'API key' : 'OAuth')

/** When this page first saw each flow event, for device-code countdowns. */
const seen = new Map<string, number>()

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const { copied, copy } = useCopy()
  return (
    <Button
      className="h-7 gap-1.5 px-2 font-mono text-[11.5px]"
      onClick={() => copy(value)}
      size="sm"
      variant="outline"
    >
      {copied ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />}
      {copied ? 'Copied' : label}
    </Button>
  )
}

function OpenButton({ url, children = 'Open' }: { url: string; children?: ReactNode }) {
  return (
    <Button asChild className="h-7 gap-1.5 px-2 font-mono text-[11.5px]" size="sm">
      <a href={url} rel="noreferrer" target="_blank">
        <ExternalLinkIcon className="size-3.5" />
        {children}
      </a>
    </Button>
  )
}

/** One provider event of a login flow, as Pi's login dialog shows it. */
function EventView({ event, flowId, index }: { event: AuthEvent; flowId: string; index: number }) {
  const key = `${flowId}:${index}`
  if (!seen.has(key)) seen.set(key, Date.now())
  switch (event.type) {
    case 'info':
      return (
        <div className="flex flex-col gap-1.5">
          <p className="font-sans text-[13px] leading-snug text-foreground/90">{event.message}</p>
          {event.links?.map((link) => (
            <a
              className="flex items-center gap-1.5 text-[12px] text-brand hover:underline"
              href={link.url}
              key={link.url}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLinkIcon className="size-3" />
              {link.label ?? link.url}
            </a>
          ))}
        </div>
      )
    case 'auth_url':
      return (
        <div className="flex flex-col gap-2">
          <p className="font-sans text-[13px] text-foreground/90">
            Open this URL in your browser to sign in:
          </p>
          <div className="rounded-md border border-border/80 bg-terminal px-2.5 py-2 text-[11.5px] break-all text-muted-foreground">
            <span className="line-clamp-3">{event.url}</span>
          </div>
          <div className="flex gap-2">
            <OpenButton url={event.url}>Open sign-in page</OpenButton>
            <CopyButton label="Copy URL" value={event.url} />
          </div>
          {event.instructions && (
            <p className="font-sans text-[12.5px] text-warning">{event.instructions}</p>
          )}
        </div>
      )
    case 'device_code':
      return <DeviceCode event={event} since={seen.get(key) ?? Date.now()} />
    default:
      return <p className="text-[12px] text-muted-foreground">{event.message}</p>
  }
}

function DeviceCode({
  event,
  since,
}: {
  event: Extract<AuthEvent, { type: 'device_code' }>
  since: number
}) {
  const now = useNow(1000, event.expiresInSeconds !== undefined)
  const left =
    event.expiresInSeconds === undefined
      ? undefined
      : Math.max(0, event.expiresInSeconds * 1000 - (now - since))
  const clock =
    left === undefined
      ? undefined
      : `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`
  return (
    <div className="flex flex-col gap-2">
      <p className="font-sans text-[13px] text-foreground/90">
        Enter this code at{' '}
        <a
          className="text-brand hover:underline"
          href={event.verificationUri}
          rel="noreferrer"
          target="_blank"
        >
          {event.verificationUri}
        </a>
        :
      </p>
      <div className="flex items-center gap-3">
        <span className="rounded-md border border-border/80 bg-terminal px-3 py-1.5 text-[22px] font-semibold tracking-[0.25em] text-foreground">
          {event.userCode}
        </span>
        <CopyButton label="Copy code" value={event.userCode} />
        <OpenButton url={event.verificationUri} />
      </div>
      {clock && (
        <p
          className={cn(
            'text-[11.5px] tabular-nums',
            left === 0 ? 'text-error' : 'text-muted-foreground',
          )}
        >
          {left === 0 ? 'code expired' : `expires in ${clock}`}
        </p>
      )}
    </div>
  )
}

/** The prompt a flow waits on, answered through the `answer` action; the next prompt replaces this form. */
function PromptForm({ flowId, prompt }: { flowId: string; prompt: AuthPrompt }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string>()
  const [sending, setSending] = useState(false)
  const answer = (text: string) => {
    setSending(true)
    setError(undefined)
    api.action(AnswerAction, { flowId, value: text }).then(
      () => undefined,
      (failure: unknown) => {
        setSending(false)
        setError(errorMessage(failure))
      },
    )
  }
  if (prompt.type === 'select')
    return (
      <div className="flex flex-col gap-1.5">
        <p className="font-sans text-[13px] text-foreground/90">{prompt.message}</p>
        {prompt.options.map((option) => (
          <button
            className="flex flex-col items-start rounded-md border border-border/80 px-2.5 py-1.5 text-left transition-colors hover:border-brand/60 hover:bg-accent/50 disabled:opacity-50"
            disabled={sending}
            key={option.id}
            onClick={() => answer(option.id)}
            type="button"
          >
            <span className="text-[12.5px] text-foreground">{option.label}</span>
            {option.description && (
              <span className="font-sans text-[12px] text-muted-foreground">
                {option.description}
              </span>
            )}
          </button>
        ))}
        {error && <p className="text-[12px] text-error">{error}</p>}
      </div>
    )
  // A text prompt may accept a blank answer ("blank for github.com"); secrets and codes may not.
  const optional = prompt.type === 'text'
  const submit = () => {
    if ((value.trim() || optional) && !sending) answer(value.trim())
  }
  // No <form> and a one-time-code field: browsers must not take an API key for a password to save.
  return (
    <div className="flex flex-col gap-1.5">
      <label className="font-sans text-[13px] text-foreground/90" htmlFor="login-answer">
        {prompt.message}
      </label>
      <div className="flex gap-2">
        <input
          autoComplete={prompt.type === 'secret' ? 'one-time-code' : 'off'}
          autoFocus
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2.5 text-[12.5px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
          data-1p-ignore
          data-bwignore
          data-lpignore="true"
          id="login-answer"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            submit()
          }}
          placeholder={
            prompt.placeholder ?? (prompt.type === 'manual_code' ? 'code or redirect URL' : '')
          }
          spellCheck={false}
          type={prompt.type === 'secret' ? 'password' : 'text'}
          value={value}
        />
        <Button
          className="h-8 px-3 text-[12px]"
          disabled={(!value.trim() && !optional) || sending}
          onClick={submit}
          type="button"
        >
          {sending ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : 'Continue'}
        </Button>
      </div>
      {error && <p className="text-[12px] text-error">{error}</p>}
    </div>
  )
}

function FlowView({
  method,
  flowId,
  error,
  onBack,
  onRetry,
  onDone,
  onRunning,
}: {
  method: Method
  flowId?: string
  error?: string
  onBack: () => void
  onRetry: () => void
  onDone: () => void
  /** The flow id while it runs, so closing the dialog can cancel it. */
  onRunning: (flowId: string | undefined) => void
}) {
  const flow = useLoginFlow(flowId)
  const actions = useUltimate()
  const status = error ? 'error' : (flow?.status ?? 'running')
  const failure = error ?? flow?.error
  useEffect(() => onRunning(status === 'running' ? flowId : undefined), [flowId, onRunning, status])
  useEffect(() => {
    // oxlint-disable-next-line typescript/no-floating-promises -- refreshModels catches fetch failures and retries on the next system event.
    if (status === 'complete') void refreshModels()
  }, [status])
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5">
        <Button
          aria-label="Back to providers"
          className="size-6 text-muted-foreground"
          disabled={status === 'running'}
          onClick={onBack}
          size="icon"
          variant="ghost"
        >
          <ArrowLeftIcon className="size-3.5" />
        </Button>
        <span className="truncate text-[13px] text-foreground">{method.name}</span>
        <span className="text-[11px] text-muted-foreground">{typeLabel(method)}</span>
        <span
          className={cn(
            'ml-auto flex items-center gap-1.5 text-[11.5px]',
            status === 'complete'
              ? 'text-success'
              : status === 'error'
                ? 'text-error'
                : status === 'cancel'
                  ? 'text-muted-foreground'
                  : 'text-brand',
          )}
        >
          {status === 'running' && <LoaderCircleIcon className="size-3 animate-spin" />}
          {status === 'running'
            ? flow?.prompt
              ? 'waiting for you'
              : 'in progress'
            : status === 'cancel'
              ? 'cancelled'
              : status === 'complete'
                ? 'logged in'
                : 'failed'}
        </span>
      </div>
      <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto px-4 py-4">
        {flowId &&
          flow?.events.map((event, index) => (
            <EventView event={event} flowId={flowId} index={index} key={index} />
          ))}
        {flow?.prompt && status === 'running' && flowId && (
          <PromptForm flowId={flowId} key={JSON.stringify(flow.prompt)} prompt={flow.prompt} />
        )}
        {status === 'running' && !flow?.prompt && (flow?.events.length ?? 0) === 0 && (
          <p className="text-[12px] text-muted-foreground">Starting {method.provider.id} login…</p>
        )}
        {status === 'complete' && (
          <p className="flex items-center gap-2 font-sans text-[13px] text-success">
            <CheckIcon className="size-4" /> Logged in to {method.provider.name}. Its models are
            available now.
          </p>
        )}
        {status === 'error' && (
          <p className="flex items-start gap-2 font-sans text-[13px] text-error">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" /> {failure ?? 'Login failed'}
          </p>
        )}
        {status === 'cancel' && (
          <p className="text-[12px] text-muted-foreground">Login cancelled.</p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border/70 px-3 py-2.5">
        {status === 'running' && flowId && (
          <Button
            className="h-7 text-[12px]"
            onClick={() => void cancel(flowId)}
            size="sm"
            variant="ghost"
          >
            Cancel
          </Button>
        )}
        {(status === 'error' || status === 'cancel') && (
          <Button className="h-7 text-[12px]" onClick={onRetry} size="sm" variant="outline">
            Try again
          </Button>
        )}
        {status === 'complete' && (
          <>
            <Button
              className="h-7 text-[12px]"
              onClick={() => {
                onDone()
                reopenPicker(actions)
              }}
              size="sm"
              variant="outline"
            >
              Pick a model
            </Button>
            <Button className="h-7 text-[12px]" onClick={onDone} size="sm">
              Done
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

function Chooser({
  initialQuery,
  onChoose,
}: {
  initialQuery: string
  onChoose: (method: Method) => void
}) {
  const models = useModels()
  const [query, setQuery] = useState(initialQuery)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  /** The row whose logout waits for a second click: the credential is shared with pi. */
  const [confirming, setConfirming] = useState<string>()
  const methods: Method[] = (models?.providers ?? [])
    .flatMap((provider) =>
      provider.authTypes.map((auth) => ({ provider, type: auth.type, name: auth.name })),
    )
    .toSorted(
      (a, b) =>
        Number(b.provider.status.configured) - Number(a.provider.status.configured) ||
        Number(b.type === 'oauth') - Number(a.type === 'oauth') ||
        a.name.localeCompare(b.name),
    )
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = methods.filter((method) =>
    terms.every((term) =>
      `${method.provider.id} ${method.name} ${typeLabel(method)}`.toLowerCase().includes(term),
    ),
  )
  const logout = (provider: ProviderInfo) => {
    setConfirming(undefined)
    setBusy(provider.id)
    setError(undefined)
    api.action(LogoutAction, { provider: provider.id }).then(
      () => {
        setBusy(undefined)
        // oxlint-disable-next-line typescript/no-floating-promises -- refreshModels catches fetch failures and retries on the next system event.
        void refreshModels()
      },
      (failure: unknown) => {
        setBusy(undefined)
        setError(errorMessage(failure))
      },
    )
  }
  return (
    <div className="flex flex-col">
      <div className="flex h-11 items-center gap-2 border-b border-border/70 px-3">
        <SearchIcon className="size-4 shrink-0 opacity-50" />
        <input
          autoFocus
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && shown[0]) onChoose(shown[0])
          }}
          placeholder="Search providers…"
          value={query}
        />
      </div>
      <div className="max-h-[55vh] overflow-y-auto p-1">
        {shown.map((method) => {
          const label = authLabel(method.provider)
          const row = `${method.provider.id}:${method.type}`
          if (confirming === row)
            return (
              <div
                className="flex flex-col gap-2 rounded-sm border border-warning/40 bg-warning/8 px-2.5 py-2"
                key={row}
              >
                <p className="font-sans text-[12.5px] text-foreground/90">
                  Log out of {method.provider.name}? This also logs out <code>pi</code>: the
                  credential is removed from{' '}
                  <span className="font-mono text-[11.5px]">~/.pi/agent/auth.json</span>.
                </p>
                <div className="flex justify-end gap-2">
                  <Button
                    autoFocus
                    className="h-7 text-[12px]"
                    onClick={() => setConfirming(undefined)}
                    size="sm"
                    variant="ghost"
                  >
                    Cancel
                  </Button>
                  <Button
                    className="h-7 gap-1.5 text-[12px]"
                    onClick={() => logout(method.provider)}
                    size="sm"
                    variant="destructive"
                  >
                    <LogOutIcon className="size-3" />
                    Log out
                  </Button>
                </div>
              </div>
            )
          return (
            <div
              className="group/row flex items-center gap-2 rounded-sm px-2 py-1.5 transition-colors hover:bg-accent/60"
              key={row}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => onChoose(method)}
                type="button"
              >
                <KeyRoundIcon
                  className={cn(
                    'size-3.5 shrink-0',
                    label ? 'text-success' : 'text-muted-foreground/60',
                  )}
                />
                <span className="truncate text-[12.5px] text-foreground">{method.name}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground/70">
                  {typeLabel(method)}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground/50">
                  {method.provider.id}
                </span>
              </button>
              {label ? (
                <>
                  <span className="shrink-0 text-[11px] text-success/90">✓ {label}</span>
                  {method.provider.status.source === 'stored' && (
                    <Button
                      className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                      disabled={busy === method.provider.id}
                      onClick={() => setConfirming(row)}
                      size="sm"
                      title={`Remove the stored ${method.provider.id} credential from ~/.pi/agent/auth.json`}
                      variant="ghost"
                    >
                      <LogOutIcon className="size-3" />
                      log out
                    </Button>
                  )}
                </>
              ) : (
                <span className="shrink-0 text-[11px] text-muted-foreground/50">
                  not configured
                </span>
              )}
            </div>
          )
        })}
        {shown.length === 0 && (
          <p className="py-6 text-center text-[12px] text-muted-foreground">No provider matches.</p>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-border/70 px-3 py-1.5 text-[11px] text-muted-foreground">
        {error ? (
          <span className="text-error">{error}</span>
        ) : (
          'Credentials are stored in ~/.pi/agent/auth.json, shared with pi.'
        )}
      </div>
    </div>
  )
}

/** Log in to a provider: pick a method, then follow the flow in the `models.login` document. */
export function LoginDialog() {
  const [open, setOpen] = useDialog(dialogs.login)
  const requested = useLoginProvider()
  const [state, setState] = useState<{ method: Method; flowId?: string; error?: string }>()
  const [running, setRunning] = useState<string>()

  const start = (method: Method) => {
    setState({ method })
    api
      .action(LoginAction, {
        provider: method.provider.id,
        type: method.type,
      })
      .then(
        ({ flowId }) => setState({ method, flowId }),
        (failure: unknown) => setState({ method, error: errorMessage(failure) }),
      )
  }
  const close = () => {
    // oxlint-disable-next-line typescript/no-floating-promises -- cancel catches failures when a flow has already ended.
    if (running) void cancel(running)
    setOpen(false)
    setState(undefined)
    setRunning(undefined)
  }
  // Pi serializes logins per provider: a flow left waiting when the tab closes would block the next one.
  useEffect(() => {
    if (!running) return undefined
    const leave = () => void cancel(running)
    addEventListener('pagehide', leave)
    return () => removeEventListener('pagehide', leave)
  }, [running])
  // A flow's document lives on the conversation that started it: showing another one ends the flow.
  const { conversationId } = useUltimate()
  const shown = useRef(conversationId)
  const leave = useEffectEvent(() => {
    if (state) close()
  })
  useEffect(() => {
    if (shown.current === conversationId) return
    shown.current = conversationId
    leave()
  }, [conversationId])
  // Another tab or pi may have logged in or out since this window last had focus.
  useEffect(() => {
    const refresh = () => void refreshModels()
    addEventListener('focus', refresh)
    return () => removeEventListener('focus', refresh)
  }, [])

  return (
    <Dialog onOpenChange={(next) => (next ? setOpen(true) : close())} open={open}>
      <DialogContent
        className="top-[16%] translate-y-0 gap-0 overflow-hidden p-0 font-mono sm:max-w-xl"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Log in to a provider</DialogTitle>
        <DialogDescription className="sr-only">
          Choose a subscription or API key login; credentials are shared with pi.
        </DialogDescription>
        {state ? (
          <FlowView
            error={state.error}
            flowId={state.flowId}
            method={state.method}
            onBack={() => setState(undefined)}
            onDone={close}
            onRetry={() => start(state.method)}
            onRunning={setRunning}
          />
        ) : (
          <Chooser initialQuery={requested ?? ''} key={requested ?? ''} onChoose={start} />
        )}
      </DialogContent>
    </Dialog>
  )
}
