import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  api,
  cn,
  defineWebExtension,
  errorMessage,
  events,
  useAction,
  useCopy,
  useEvent,
  useSystem,
} from '@/sdk'
import { encode } from 'uqr'
import { RetryAction, StatusAction } from './refs.ts'
import type { Status } from './refs.ts'
type Problem = Exclude<Status['state'], 'disabled' | 'starting' | 'ready'>

const problems: Record<Problem, { title: string; link?: { href: string; label: string } }> = {
  'not-installed': {
    title: 'Tailscale is not installed',
    link: { href: 'https://tailscale.com/download', label: 'Download Tailscale' },
  },
  'not-running': { title: 'Tailscale is not running' },
  'not-operator': { title: 'Not a Tailscale operator' },
  'https-disabled': {
    title: 'HTTPS certificates are off',
    link: { href: 'https://login.tailscale.com/admin/dns', label: 'Open the admin console' },
  },
  'port-conflict': { title: 'Its HTTPS port is taken' },
  error: { title: 'Tailscale failed' },
}

/**
 * The status, read on mount and again when what it depends on shows in system info: a registered origin, a facet
 * notice (each failure posts one), or a reinstall after a settings change.
 */
function useStatus() {
  const system = useSystem()
  // Failures show where the status does, not as notices: the status line reads it on every page.
  const status = useAction(StatusAction, null, { onError: () => {} })
  const signature = JSON.stringify([
    system?.access.origins,
    system?.extensionDiagnostics,
    system?.extensions.find((extension) => extension.name === 'tailscale')?.server?.loadedAt,
  ])
  const seen = useRef(signature)
  const { refetch } = status
  useEffect(() => {
    if (signature === seen.current) return
    seen.current = signature
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    void refetch()
  }, [signature, refetch])
  return status
}

/** A shell command to copy, as a code chip. */
function Command({ value }: { value: string }) {
  const { copied, copy } = useCopy()
  return (
    <button
      aria-label={`Copy ${value}`}
      className="group mt-2 flex w-full items-center gap-2 rounded-md border border-border/80 bg-background px-2 py-1.5 text-left font-mono text-[0.7188rem] text-foreground/90 transition-colors outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => copy(value)}
      title="Copy"
      type="button"
    >
      <span className="text-muted-foreground select-none">$</span>
      <code className="min-w-0 flex-1 break-all">{value}</code>
      {copied ? (
        <CheckIcon className="size-3.5 shrink-0 text-success" />
      ) : (
        <CopyIcon className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
      )}
    </button>
  )
}

/** A hint's command, such as `tailscale up` in "Start Tailscale and log in (tailscale up).", and the words around it. */
function split(hint: string) {
  const match = /(?:sudo )?tailscale [^()]*?(?=\)|\.?$)/.exec(hint)
  if (!match) return { text: hint }
  const text = hint.slice(0, match.index) + hint.slice(match.index + match[0].length)
  return { text: text.replace(' ()', '').trim(), command: match[0] }
}

function Heading({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 section-label">
      {children}
      {meta !== undefined && <span className="ml-auto flex items-center gap-1.5">{meta}</span>}
    </div>
  )
}

const dot = (tone: string) => <span className={cn('size-1.5 rounded-full', tone)} />

function Ready({ url, allow }: { url: string; allow: string[] }) {
  const { copied, copy } = useCopy()
  return (
    <>
      <div className="mt-3">
        <QrCode text={url} />
      </div>
      <p className="mt-2.5 rounded-md border border-border/80 bg-background px-2.5 py-2 font-mono text-[0.7812rem] leading-snug break-all text-foreground">
        {url}
      </p>
      <div className="mt-2 flex gap-1.5">
        <Button
          className="h-7 gap-1.5 px-2 font-mono text-[0.7188rem]"
          onClick={() => copy(url)}
          size="sm"
          variant="outline"
        >
          {copied ? (
            <CheckIcon className="size-3.5 text-success" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button
          asChild
          className="h-7 gap-1.5 px-2 font-mono text-[0.7188rem]"
          size="sm"
          variant="outline"
        >
          <a href={url} rel="noreferrer" target="_blank">
            <ExternalLinkIcon className="size-3.5" />
            Open
          </a>
        </Button>
      </div>
      <p className="mt-3 flex items-start gap-1.5 text-[0.75rem] leading-snug text-muted-foreground">
        <ShieldCheckIcon className="mt-px size-3.5 shrink-0 text-success" />
        <span className="min-w-0 break-words">
          Only <span className="text-foreground/90">{allow.join(', ')}</span> can open it
        </span>
      </p>
      <p className="mt-1 pl-5 text-[0.75rem] leading-snug text-muted-foreground">
        Tailnet only, never on the public internet.
      </p>
    </>
  )
}

function Trouble({ state, hint }: { state: Problem; hint?: string }) {
  const { title, link } = problems[state]
  const { text, command } = hint && state !== 'error' ? split(hint) : { text: hint }
  return (
    <>
      <p className="mt-2.5 flex items-center gap-1.5 text-[0.8125rem] text-foreground">
        <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" />
        {title}
      </p>
      {text && (
        <p
          className={cn(
            'mt-1 leading-snug break-words',
            state === 'error'
              ? 'line-clamp-4 font-mono text-[0.6875rem] text-error/85'
              : 'text-[0.75rem] text-muted-foreground',
          )}
          title={state === 'error' ? text : undefined}
        >
          {text}
        </p>
      )}
      {command && <Command value={command} />}
      {link && (
        <a
          className="mt-2 inline-flex items-center gap-1 text-[0.75rem] text-brand outline-none hover:underline focus-visible:underline"
          href={link.href}
          rel="noreferrer"
          target="_blank"
        >
          {link.label}
          <ExternalLinkIcon className="size-3" />
        </a>
      )}
    </>
  )
}

/** Runs the start again, as after fixing what a problem names or to restore a lost mapping, then reads the status. */
function CheckAgain({ onChecked }: { onChecked: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const check = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await api.action(RetryAction)
      await onChecked()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button
        className="mt-3 h-7 gap-1.5 px-2 font-mono text-[0.7188rem]"
        disabled={busy}
        onClick={() => void check()}
        size="sm"
        variant="outline"
      >
        {busy ? (
          <LoaderCircleIcon className="size-3.5 animate-spin" />
        ) : (
          <RefreshCwIcon className="size-3.5" />
        )}
        Check again
      </Button>
      {error && <p className="mt-2 font-mono text-[0.6875rem] leading-snug text-error">{error}</p>}
    </>
  )
}

const quiet = (label: string) => (
  <span className="flex items-center gap-1.5 text-muted-foreground">
    <LoaderCircleIcon className="size-3 animate-spin" />
    {label}
  </span>
)

/** Everything about the tailnet in one place: the address to scan, or what to fix. */
function Details({ status }: { status: ReturnType<typeof useStatus> }) {
  const { data, error, refetch } = status
  const state = data?.state
  const meta =
    state === 'ready' ? (
      <span className="flex items-center gap-1.5 text-success">
        {dot('bg-success')}
        reachable
      </span>
    ) : state === 'disabled' ? (
      <span className="text-muted-foreground">off</span>
    ) : state === 'starting' || (!data && !error) ? (
      quiet('starting…')
    ) : state ? (
      <span className="flex items-center gap-1.5 text-warning">
        {dot('bg-warning')}
        needs a fix
      </span>
    ) : undefined
  return (
    <section className="px-3 pt-3 pb-3.5 font-sans">
      <Heading meta={meta}>Tailnet</Heading>
      {error && !data && (
        <p className="mt-2.5 font-mono text-[0.6875rem] leading-snug text-error">
          {errorMessage(error)}
        </p>
      )}
      {state === 'ready' && data?.url && <Ready allow={data.allow} url={data.url} />}
      {state && state in problems && <Trouble hint={data?.hint} state={state as Problem} />}
      {/* Ready too: it serves the mapping again if something removed it behind this server's back. */}
      {(state === 'ready' || (state && state in problems)) && <CheckAgain onChecked={refetch} />}
    </section>
  )
}

/**
 * `text` as a QR code to scan with a phone: one SVG path with a rectangle per run of dark modules in a row, black on
 * white in either theme so every camera reads it.
 */
function QrCode({ text }: { text: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(text, { border: 2 })
    let d = ''
    qr.data.forEach((row, y) => {
      for (let x = 0; x < qr.size; x++) {
        if (!row[x]) continue
        const start = x
        while (row[x + 1]) x++
        d += `M${start} ${y}h${x - start + 1}v1h${start - x - 1}z`
      }
    })
    return { size: qr.size, path: d }
  }, [text])
  return (
    <svg
      aria-label={`QR code for ${text}`}
      className="mx-auto block size-36 rounded-sm bg-white"
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${size} ${size}`}
    >
      <path d={path} fill="black" />
    </svg>
  )
}

/**
 * "tailnet" in the status line: a green dot while this Ultimate is reachable there, amber while it needs a fix. A click
 * opens the details above it. Off or starting, it stays out of the line; `Tailscale…` in the palette opens the details
 * anchored where it would be.
 */
function Indicator() {
  const status = useStatus()
  const [open, setOpen] = useState(false)
  useEvent('tailscale:open', () => setOpen(true))
  const state = status.data?.state
  const trouble = state !== undefined && state in problems
  const shown = (state === 'ready' && !!status.data?.url) || trouble
  if (!shown && !open) return null
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        {shown ? (
          <button
            className={cn(
              '-mx-1 flex items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground',
              trouble && 'text-warning',
            )}
            data-tailnet={state}
            title={trouble ? 'Tailnet needs a fix' : 'Reachable on your tailnet'}
            type="button"
          >
            {dot(trouble ? 'bg-warning' : 'bg-success')}
            tailnet
          </button>
        ) : (
          // Off or starting there is nothing to show in the bar; the palette's details hang from here.
          <span aria-hidden className="h-4 w-0" />
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-1rem)] p-0" side="top">
        <Details status={status} />
      </PopoverContent>
    </Popover>
  )
}

export default defineWebExtension({
  slots: { 'statusline.right': [Indicator] },
  commands: [
    {
      id: 'tailscale.panel',
      title: 'Tailscale…',
      run: () => events.emit('tailscale:open', undefined),
    },
  ],
})
