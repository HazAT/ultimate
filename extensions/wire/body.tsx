/** A call's request and response, readable (structure first) or raw. */
import { ChevronRightIcon } from 'lucide-react'
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { formatTokens } from '@/sdk'
import type { WireCall, WireUsage } from './refs.ts'
import {
  CacheMark,
  Children,
  Fields,
  Node,
  Part,
  TextBlock,
  isBranch,
  isObject,
  scalar,
} from './tree.tsx'
import type { Json, JsonObject } from './tree.tsx'

const parse = (text: string): Json | undefined => {
  try {
    return JSON.parse(text) as Json
  } catch {
    // A body that is not JSON (an error page, a truncated stream) shows as text instead.
    return undefined
  }
}

/** The parts of a request body in the order the provider caches them; the rest are settings. */
const CACHE_ORDER: Record<string, string[]> = {
  anthropic: ['tools', 'system', 'messages'],
  responses: ['instructions', 'tools', 'input'],
}

/** A header's value; a comma list (`anthropic-beta`) one item per line. */
function HeaderValue({ name, value }: { name: string; value: string }) {
  if (value === '[redacted]') return <span className="text-muted-foreground/60">{value}</span>
  if (!name.endsWith('-beta')) return value
  return (
    <span className="flex flex-col">
      {value.split(',').map((beta) => (
        <span className="text-brand/90" key={beta}>
          {beta.trim()}
        </span>
      ))}
    </span>
  )
}

function Headers({ headers }: { headers: Record<string, string> }) {
  return (
    <Fields
      fields={Object.entries(headers).map(([key, value]) => [
        key,
        HeaderValue({ name: key, value }),
      ])}
    />
  )
}

/** A part that starts folded: headers, a stream's events. */
function Folded({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <Collapsible className="mt-5 first:mt-0">
      <CollapsibleTrigger className="flex w-full cursor-pointer items-baseline gap-2 border-b border-border/60 pr-2 pb-1 text-left">
        <ChevronRightIcon className="size-3 shrink-0 translate-y-[2px] self-start text-muted-foreground/60 transition-transform [[data-state=open]>&]:rotate-90" />
        <span className="section-label text-foreground/80">{title}</span>
        <span className="text-muted-foreground/70">{note}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1">{children}</CollapsibleContent>
    </Collapsible>
  )
}

/** Settings outside the cached prefix: model, max_tokens, thinking … */
function Settings({ body }: { body: JsonObject }) {
  return (
    <div className="flex flex-col">
      {Object.entries(body).map(([key, value]) =>
        isBranch(value) || (typeof value === 'string' && value.length > 96) ? (
          <Node key={key} label={key} value={value} />
        ) : (
          <div className="flex h-6 items-baseline gap-2 pr-2 pl-6" key={key}>
            <span className="w-40 shrink-0 truncate text-muted-foreground">{key}</span>
            <span className="min-w-0 truncate text-foreground/85">{scalar(value)}</span>
          </div>
        ),
      )}
    </div>
  )
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** Where the body's `cache_control` markers sit, as paths, in body order. */
function breakpoints(value: Json, path: string, out: { path: string; ttl?: string }[] = []) {
  if (Array.isArray(value))
    value.forEach((item, index) => breakpoints(item, `${path}[${index}]`, out))
  else if (isObject(value))
    for (const [key, item] of Object.entries(value)) {
      if (key === 'cache_control' && isObject(item))
        out.push({ path, ...(typeof item.ttl === 'string' ? { ttl: item.ttl } : {}) })
      else breakpoints(item, path ? `${path}.${key}` : key, out)
    }
  return out
}

/** The request, structure first: its cache breakpoints, headers, the prefix in cache order, then settings. */
export function ReadableRequest({ call }: { call: WireCall }) {
  const body = useMemo(() => parse(call.request), [call.request])
  if (!body || !isObject(body)) return <TextBlock text={call.request} />
  const order = 'messages' in body ? CACHE_ORDER.anthropic : CACHE_ORDER.responses
  const settings = Object.fromEntries(Object.entries(body).filter(([key]) => !order.includes(key)))
  const marks = order.flatMap((key) => (body[key] === undefined ? [] : breakpoints(body[key], key)))
  return (
    <>
      {marks.length > 0 && (
        <Part
          note="the provider caches the prefix up to each, in the order below"
          title="cache breakpoints"
        >
          <div className="flex flex-col gap-0.5 px-1 py-1">
            {marks.map((mark) => (
              <span className="flex items-center gap-2" key={mark.path}>
                <CacheMark ttl={mark.ttl} />
                <span className="text-foreground/85">{mark.path}</span>
              </span>
            ))}
          </div>
        </Part>
      )}
      {call.requestHeaders && (
        <Folded
          note={`${Object.keys(call.requestHeaders).length} · ${call.url ?? ''}`}
          title="headers"
        >
          <Headers headers={call.requestHeaders} />
        </Folded>
      )}
      {order.map((key, index) => {
        const value = body[key]
        if (value === undefined) return null
        const count = Array.isArray(value) ? value.length : undefined
        return (
          <Part
            key={key}
            note={[
              count === undefined
                ? undefined
                : plural(count, key === 'tools' ? 'tool' : key === 'system' ? 'block' : 'item'),
              index === 0 ? 'cached first' : undefined,
            ]
              .filter(Boolean)
              .join(' · ')}
            size={JSON.stringify(value).length}
            title={key}
          >
            {isBranch(value) ? <Children value={value} /> : <Node label={key} value={value} />}
          </Part>
        )
      })}
      <Part title="settings" note="outside the cached prefix">
        <Settings body={settings} />
      </Part>
    </>
  )
}

/** A body exactly as kept, pretty-printed when it is JSON. Plain text, never highlighted: it can be megabytes. */
export function Raw({ text }: { text: string }) {
  const pretty = useMemo(() => {
    const value = parse(text)
    return value === undefined ? text : JSON.stringify(value, null, 2)
  }, [text])
  return (
    <pre className="rounded-sm bg-terminal px-3 py-2 text-[11.5px] leading-[1.55] break-all whitespace-pre-wrap text-foreground/85">
      {pretty}
    </pre>
  )
}

type Event = { name: string; data: string }

/** The events of a server-sent stream, in order. */
const events = (stream: string): Event[] =>
  stream
    .split(/\r?\n\r?\n/u)
    .map((chunk) => {
      const lines = chunk.split(/\r?\n/u)
      const name =
        lines
          .find((line) => line.startsWith('event:'))
          ?.slice(6)
          .trim() ?? 'message'
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      return { name, data }
    })
    .filter((event) => event.data || event.name !== 'message')

/** Runs of the same event, so 200 deltas read as one row. */
function runs(list: Event[]) {
  const out: { name: string; events: Event[] }[] = []
  for (const event of list) {
    const last = out.at(-1)
    if (last?.name === event.name) last.events.push(event)
    else out.push({ name: event.name, events: [event] })
  }
  return out
}

/** What a run of deltas adds up to: the text, thinking or tool input they stream. */
function joined(list: Event[]) {
  return list
    .map((event) => {
      const delta = (parse(event.data) as { delta?: Record<string, unknown> } | undefined)?.delta
      const piece = delta?.text ?? delta?.thinking ?? delta?.partial_json ?? delta
      return typeof piece === 'string' ? piece : ''
    })
    .join('')
}

/** One run of the stream's events; a single event opens straight to its data. */
function Run({ name, list }: { name: string; list: Event[] }) {
  const value = (event: Event): Json => parse(event.data) ?? event.data
  const hint = useMemo(() => joined(list).replaceAll(/\s+/gu, ' ').trim(), [list])
  if (list.length === 1) return <Node label={name} value={value(list[0])} />
  return (
    <Collapsible>
      <CollapsibleTrigger className="flex h-6 w-full cursor-pointer items-center gap-2 rounded-sm pr-2 pl-1 text-left hover:bg-accent/50">
        <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/60 transition-transform [[data-state=open]>&]:rotate-90" />
        <span className="text-muted-foreground">{name}</span>
        <span className="shrink-0 text-foreground/90">× {list.length}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground/60">{hint}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-[9px] border-l border-border/60 pl-2">
        {list.map((event, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- Events of a finished stream are positional.
          <Node key={index} label={`[${index}]`} value={value(event)} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function Usage({ usage }: { usage: WireUsage }) {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite
  const cells: [string, number, string][] = [
    ['cache read', usage.cacheRead, 'bg-brand/60'],
    ['cache write', usage.cacheWrite, 'bg-warning/70'],
    ['input', usage.input, 'bg-muted-foreground/50'],
  ]
  return (
    <div className="flex flex-col gap-2 px-1 py-1.5">
      {prompt > 0 && (
        <span aria-hidden className="flex h-1 overflow-hidden rounded-full bg-muted">
          {cells.map(([key, tokens, tone]) =>
            tokens > 0 ? (
              <span className={tone} key={key} style={{ width: `${(tokens / prompt) * 100}%` }} />
            ) : null,
          )}
        </span>
      )}
      <div className="flex flex-wrap gap-x-5 gap-y-1">
        {cells.map(([key, tokens, tone]) => (
          <span className="flex items-center gap-1.5" key={key}>
            <span className={`size-2 rounded-[2px] ${tone}`} />
            <span className="text-muted-foreground">{key}</span>
            <span className="text-foreground/90 tabular-nums" title={tokens.toLocaleString()}>
              {formatTokens(tokens)}
            </span>
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="text-muted-foreground">output</span>
          <span className="text-foreground/90 tabular-nums">{formatTokens(usage.output)}</span>
        </span>
      </div>
    </div>
  )
}

/** What came back: usage, the assembled message, and for a relay call the response headers and its event stream. */
export function ReadableResponse({ call }: { call: WireCall }) {
  const stream = useMemo(() => (call.response ? events(call.response) : []), [call.response])
  const relay = call.source === 'relay'
  return (
    <>
      {call.failure && (
        <Part title="failure">
          <TextBlock className="text-error" text={call.failure} />
        </Part>
      )}
      {call.usage && (
        <Part title="usage">
          <Usage usage={call.usage} />
        </Part>
      )}
      {call.responseHeaders && (
        <Folded
          note={`${call.status ?? ''} · ${Object.keys(call.responseHeaders).length}`}
          title="headers"
        >
          <Headers headers={call.responseHeaders} />
        </Folded>
      )}
      {call.message !== undefined && (
        <Part
          note={relay ? 'as the relay assembled it from the stream' : 'assembled by Pi'}
          size={JSON.stringify(call.message).length}
          title="message"
        >
          {isBranch(call.message as Json) ? (
            <Children value={call.message as JsonObject} />
          ) : (
            <Node label="message" value={call.message as Json} />
          )}
        </Part>
      )}
      {call.response !== undefined &&
        (stream.length > 0 ? (
          <Part
            note={`${plural(stream.length, 'event')} · as received`}
            size={call.response.length}
            title="event stream"
          >
            {runs(stream).map((run, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- Runs of a finished stream are positional.
              <Run key={index} list={run.events} name={run.name} />
            ))}
          </Part>
        ) : (
          <Part size={call.response.length} title="body">
            <TextBlock text={call.response} />
          </Part>
        ))}
      {!relay && (
        <p className="mt-5 text-muted-foreground/70">
          {call.provider}'s transport bytes and headers stay inside pi-ai; this is the message Pi
          assembled from them.
        </p>
      )}
    </>
  )
}

/** The response as kept: the raw event stream (relay), or Pi's assembled message as JSON. */
export function RawResponse({ call }: { call: WireCall }) {
  if (call.response !== undefined)
    return (
      <pre className="rounded-sm bg-terminal px-3 py-2 text-[11.5px] leading-[1.55] break-all whitespace-pre-wrap text-foreground/85">
        {call.response}
      </pre>
    )
  return <Raw text={JSON.stringify(call.message ?? null)} />
}
