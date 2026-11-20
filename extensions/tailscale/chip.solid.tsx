/** @jsxImportSource @solidjs/web */
import {
  Check,
  Copy,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from '@lucide/solid'
import { createMemo, createSignal, Match, Show, Switch } from 'solid-js'
import { encode } from 'uqr'
import { Button } from '@/components/ui/button.solid.tsx'
import { Popover, PopoverContent } from '@/components/ui/popover.solid.tsx'
import { StatusPopoverTrigger } from '@/components/ui/status-trigger.solid.tsx'
import {
  ROOT,
  api,
  cn,
  errorMessage,
  keepLast,
  useAction,
  useCopy,
  useEvent,
  useSystem,
} from '@/sdk/solid'
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

function useStatus() {
  const system = useSystem()
  return useAction(StatusAction, null, {
    conversation: ROOT,
    onError: keepLast,
    on: () => [
      system()?.access.origins,
      system()?.extensionDiagnostics,
      system()?.extensions.find((extension) => extension.name === 'tailscale')?.server?.loadedAt,
    ],
  })
}

function CopyCommand(props: { value: string }) {
  const { copied, copy } = useCopy()
  return (
    <Button
      aria-label={`Copy ${props.value}`}
      class="group mt-2 flex w-full justify-start gap-2 rounded-md border border-border/80 bg-background px-2 py-1.5 text-left font-mono text-[11.5px] font-normal whitespace-normal text-foreground/90 transition-colors outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => copy(props.value)}
      size={null}
      title="Copy"
      variant={null}
    >
      <span class="text-muted-foreground/60 select-none">$</span>
      <code class="min-w-0 flex-1 break-all">{props.value}</code>
      <Show
        when={copied()}
        fallback={
          <Copy class="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
        }
      >
        <Check class="size-3.5 shrink-0 text-success" />
      </Show>
    </Button>
  )
}

function split(hint: string) {
  const match = /(?:sudo )?tailscale [^()]*?(?=\)|\.?$)/.exec(hint)
  if (!match) return { text: hint }
  const text = hint.slice(0, match.index) + hint.slice(match.index + match[0].length)
  return { text: text.replace(' ()', '').trim(), command: match[0] }
}

const dot = (tone: string) => <span class={cn('size-1.5 rounded-full', tone)} />
const actionClass = 'h-7 gap-1.5 px-2 font-mono text-[11.5px]'

function Ready(props: { url: string; allow: string[]; hint?: string }) {
  const { copied, copy } = useCopy()
  return (
    <>
      <QrCode text={props.url} />
      <p class="mt-2.5 rounded-md border border-border/80 bg-background px-2.5 py-2 font-mono text-[12.5px] leading-snug break-all text-foreground">
        {props.url}
      </p>
      <div class="mt-2 flex gap-1.5">
        <Button class={actionClass} onClick={() => copy(props.url)} size="sm" variant="outline">
          <Show when={copied()} fallback={<Copy class="size-3.5" />}>
            <Check class="size-3.5 text-success" />
          </Show>
          {copied() ? 'Copied' : 'Copy'}
        </Button>
        <Button
          class={actionClass}
          render={(linkProps) => (
            <a {...linkProps} href={props.url} rel="noreferrer" target="_blank">
              <ExternalLink class="size-3.5" />
              Open
            </a>
          )}
          size="sm"
          variant="outline"
        />
      </div>
      <p class="mt-3 flex items-start gap-1.5 text-[12px] leading-snug text-muted-foreground">
        <ShieldCheck class="mt-px size-3.5 shrink-0 text-success" />
        <span class="min-w-0 break-words">
          <Show when={props.allow.length} fallback={props.hint}>
            Only <span class="text-foreground/90">{props.allow.join(', ')}</span> can open it
          </Show>
        </span>
      </p>
      <p class="mt-1 pl-5 text-[12px] leading-snug text-muted-foreground/80">
        Tailnet only, never on the public internet.
      </p>
    </>
  )
}

function Trouble(props: { state: Problem; hint?: string }) {
  const problem = () => problems[props.state]
  const hint = createMemo<{ text?: string; command?: string }>(() =>
    props.hint && props.state !== 'error' ? split(props.hint) : { text: props.hint },
  )
  return (
    <>
      <p class="mt-2.5 flex items-center gap-1.5 text-[13px] text-foreground">
        <TriangleAlert class="size-3.5 shrink-0 text-warning" />
        {problem().title}
      </p>
      <Show when={hint().text}>
        {(text) => (
          <p
            class={cn(
              'mt-1 leading-snug break-words',
              props.state === 'error'
                ? 'line-clamp-4 font-mono text-[11px] text-error/85'
                : 'text-[12px] text-muted-foreground',
            )}
            title={props.state === 'error' ? text() : undefined}
          >
            {text()}
          </p>
        )}
      </Show>
      <Show when={hint().command}>{(command) => <CopyCommand value={command()} />}</Show>
      <Show when={problem().link}>
        {(link) => (
          <Button
            class="mt-2 gap-1 rounded-none text-[12px] font-normal text-brand outline-none hover:underline focus-visible:ring-0 focus-visible:underline"
            render={(linkProps) => (
              <a {...linkProps} href={link().href} rel="noreferrer" target="_blank">
                {link().label}
                <ExternalLink class="size-3" />
              </a>
            )}
            size={null}
            variant={null}
          />
        )}
      </Show>
    </>
  )
}

function Retry(props: { refresh: () => Promise<unknown> }) {
  const [error, setError] = createSignal<string>()
  const check = async () => {
    setError(undefined)
    try {
      await api.action(RetryAction, null, { conversationId: ROOT })
      await props.refresh()
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }
  return (
    <>
      <Button
        class={cn(actionClass, 'mt-3 data-pending:opacity-50')}
        onClick={check}
        size="sm"
        variant="outline"
      >
        <LoaderCircle class="hidden size-3.5 animate-spin in-data-pending:block" />
        <RefreshCw class="size-3.5 in-data-pending:hidden" />
        Check again
      </Button>
      <Show when={error()}>
        {(message) => <p class="mt-2 font-mono text-[11px] leading-snug text-error">{message()}</p>}
      </Show>
    </>
  )
}

function Details(props: { status: ReturnType<typeof useStatus>; problem?: Problem }) {
  const data = () => props.status.data()
  const error = () => props.status.error()
  const state = () => data()?.state
  return (
    <section class="px-3 pt-3 pb-3.5 font-sans">
      <div class="flex items-center justify-between gap-2 section-label">
        Tailnet
        <Switch>
          <Match when={state() === 'ready'}>
            <span class="flex items-center gap-1.5 text-success">
              {dot('bg-success')} reachable
            </span>
          </Match>
          <Match when={state() === 'disabled'}>
            <span class="text-muted-foreground/70">off</span>
          </Match>
          <Match when={state() === 'starting' || (!data() && !error())}>
            <span class="flex items-center gap-1.5 text-muted-foreground">
              <LoaderCircle class="size-3 animate-spin" />
              starting…
            </span>
          </Match>
          <Match when={props.problem}>
            <span class="flex items-center gap-1.5 text-warning">
              {dot('bg-warning')} needs a fix
            </span>
          </Match>
        </Switch>
      </div>
      <Show when={!data() && error()}>
        {(failure) => (
          <p class="mt-2.5 font-mono text-[11px] leading-snug text-error">
            {errorMessage(failure())}
          </p>
        )}
      </Show>
      <Show when={state() === 'ready' && data()?.url}>
        {(url) => <Ready allow={data()!.allow} hint={data()?.hint} url={url()} />}
      </Show>
      <Show when={props.problem}>
        {(problem) => <Trouble hint={data()?.hint} state={problem()} />}
      </Show>
      <Show when={state() === 'ready' || props.problem}>
        <Retry refresh={props.status.refetch} />
      </Show>
    </section>
  )
}

function QrCode(props: { text: string }) {
  const qr = createMemo(() => {
    const { data, size } = encode(props.text, { border: 2 })
    let path = ''
    data.forEach((row, y) => {
      for (let x = 0; x < size; x++) {
        if (!row[x]) continue
        const start = x
        while (row[x + 1]) x++
        path += `M${start} ${y}h${x - start + 1}v1h${start - x - 1}z`
      }
    })
    return { size, path }
  })
  return (
    <svg
      aria-label={`QR code for ${props.text}`}
      class="mx-auto mt-3 block size-36 rounded-sm bg-white"
      shape-rendering="crispEdges"
      viewBox={`0 0 ${qr().size} ${qr().size}`}
    >
      <title>QR code for {props.text}</title>
      <path d={qr().path} fill="black" />
    </svg>
  )
}

export function Chip() {
  const status = useStatus()
  const [open, setOpen] = createSignal(false)
  const [anchor, setAnchor] = createSignal<HTMLSpanElement>()
  useEvent('tailscale:open', () => setOpen(true))
  const state = () => status.data()?.state
  const problem = createMemo(() => {
    const current = state()
    return current && current in problems ? (current as Problem) : undefined
  })
  const shown = () => (state() === 'ready' && !!status.data()?.url) || !!problem()
  return (
    <Show when={shown() || open()}>
      <Popover onOpenChange={setOpen} open={open()}>
        <Show when={shown()} fallback={<span aria-hidden="true" class="h-4 w-0" ref={setAnchor} />}>
          <StatusPopoverTrigger
            class={cn(problem() && 'text-warning')}
            data-tailnet={state()}
            title={problem() ? 'Tailnet needs a fix' : 'Reachable on your tailnet'}
          >
            {problem() ? dot('bg-warning') : dot('bg-success')}
            tailnet
          </StatusPopoverTrigger>
        </Show>
        <PopoverContent
          align="end"
          anchor={shown() ? undefined : anchor()}
          aria-label="Tailnet"
          class="w-80 max-w-[calc(100vw-1rem)] p-0"
          side="top"
        >
          <Details problem={problem()} status={status} />
        </PopoverContent>
      </Popover>
    </Show>
  )
}
