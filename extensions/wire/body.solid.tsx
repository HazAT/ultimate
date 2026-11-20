/** @jsxImportSource @solidjs/web */
import { For, Show, createMemo } from 'solid-js'
import { formatTokens, plural } from '@/sdk/solid'
import { isBranch, isObject, parse, requestShape } from './json.ts'
import type { Json, JsonObject } from './json.ts'
import type { WireCall, WireUsage } from './refs.ts'
import { CacheMark, Children, Fold, Node, Part, TextBlock } from './tree.solid.tsx'

type Event = { name: string; data: string }

function events(stream: string): Event[] {
  return stream
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
}

function runs(list: Event[]) {
  const out: { name: string; events: Event[] }[] = []
  for (const event of list) {
    const last = out.at(-1)
    if (last?.name === event.name) last.events.push(event)
    else out.push({ name: event.name, events: [event] })
  }
  return out
}

function HeaderValue(props: { name: string; value: string }) {
  return (
    <Show
      when={props.value !== '[redacted]'}
      fallback={<span class="text-muted-foreground/60">[redacted]</span>}
    >
      <Show when={props.name.endsWith('-beta')} fallback={props.value}>
        <span class="flex flex-col">
          <For each={props.value.split(',')}>
            {(beta) => <span class="text-brand/90">{beta.trim()}</span>}
          </For>
        </span>
      </Show>
    </Show>
  )
}

function Headers(props: { name: string; note: string; headers: Record<string, string> }) {
  return (
    <Fold
      class="mt-5 first:mt-0"
      name={props.name}
      triggerClass="h-auto items-baseline rounded-none border-b border-border/60 pb-1 pl-0 hover:bg-transparent"
      panelClass="pt-1"
      label={
        <>
          <span class="section-label text-foreground/80">headers</span>
          <span class="text-muted-foreground/70">{props.note}</span>
        </>
      }
    >
      <dl class="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)] gap-x-4 gap-y-0.5 px-1 py-1">
        <For each={Object.entries(props.headers)} keyed={([name]) => name}>
          {(entry) => (
            <div class="contents">
              <dt class="truncate text-muted-foreground">{entry()[0]}</dt>
              <dd class="min-w-0 break-all text-foreground/85">
                <HeaderValue name={entry()[0]} value={entry()[1]} />
              </dd>
            </div>
          )}
        </For>
      </dl>
    </Fold>
  )
}

function Settings(props: { body: JsonObject }) {
  return (
    <div class="flex flex-col">
      <For each={Object.entries(props.body)} keyed={([key]) => key}>
        {(entry) => {
          const value = () => entry()[1]
          const expanded = () => {
            const item = value()
            return isBranch(item) || (typeof item === 'string' && item.length > 96)
          }
          return (
            <Show
              when={expanded()}
              fallback={
                <div class="flex h-6 items-baseline gap-2 pr-2 pl-6">
                  <span class="w-40 shrink-0 truncate text-muted-foreground">{entry()[0]}</span>
                  <span class="min-w-0 truncate text-foreground/85">{JSON.stringify(value())}</span>
                </div>
              }
            >
              <Node
                label={entry()[0]}
                path={`settings[${JSON.stringify(entry()[0])}]`}
                value={value()}
              />
            </Show>
          )
        }}
      </For>
    </div>
  )
}

function PrefixPart(props: { title: string; value: Json; first: boolean }) {
  const note = () => {
    const value = props.value
    return [
      Array.isArray(value)
        ? plural(
            value.length,
            props.title === 'tools' ? 'tool' : props.title === 'system' ? 'block' : 'item',
          )
        : '',
      props.first ? 'cached first' : '',
    ]
      .filter(Boolean)
      .join(' · ')
  }
  return (
    <Part note={note()} size={JSON.stringify(props.value).length} title={props.title}>
      <Show
        when={isBranch(props.value) && props.value}
        fallback={<Node label={props.title} path={props.title} value={props.value} />}
      >
        {(value) => <Children path={props.title} value={value()} />}
      </Show>
    </Part>
  )
}

function RequestBody(props: { call: WireCall; body: JsonObject }) {
  const shape = createMemo(() => requestShape(props.body))
  return (
    <>
      <Show when={shape().marks.length > 0}>
        <Part
          note="the provider caches the prefix up to each, in the order below"
          title="cache breakpoints"
        >
          <div class="flex flex-col gap-0.5 px-1 py-1">
            <For each={shape().marks} keyed={(mark) => mark.path}>
              {(mark) => (
                <span class="flex items-center gap-2">
                  <CacheMark ttl={mark().ttl} />
                  <span class="text-foreground/85">{mark().path}</span>
                </span>
              )}
            </For>
          </div>
        </Part>
      </Show>
      <Show when={props.call.requestHeaders}>
        {(headers) => (
          <Headers
            headers={headers()}
            name="Request headers"
            note={`${Object.keys(headers()).length} · ${props.call.url ?? ''}`}
          />
        )}
      </Show>
      <For each={shape().order.filter((key) => props.body[key] !== undefined)}>
        {(key) => (
          <PrefixPart first={key === shape().order[0]} title={key} value={props.body[key]} />
        )}
      </For>
      <Part title="settings" note="outside the cached prefix">
        <Settings body={shape().settings} />
      </Part>
    </>
  )
}

export function ReadableRequest(props: { call: WireCall }) {
  const body = createMemo(() => {
    const value = parse(props.call.request)
    return value !== undefined && isObject(value) ? value : undefined
  })
  return (
    <Show when={body()} fallback={<TextBlock text={props.call.request} />}>
      {(value) => <RequestBody body={value()} call={props.call} />}
    </Show>
  )
}

function RawBlock(props: { text: string }) {
  return (
    <pre class="rounded-sm bg-terminal px-3 py-2 text-[11.5px] leading-[1.55] break-all whitespace-pre-wrap text-foreground/85">
      {props.text}
    </pre>
  )
}

export function Raw(props: { text: string }) {
  const pretty = createMemo(() => {
    const value = parse(props.text)
    return value === undefined ? props.text : JSON.stringify(value, null, 2)
  })
  return <RawBlock text={pretty()} />
}

function Run(props: { name: string; list: Event[]; index: number }) {
  const path = () => `event stream run ${props.index + 1} ${props.name}`
  const hint = createMemo(() =>
    props.list
      .map((event) => {
        const delta = (parse(event.data) as { delta?: Record<string, unknown> } | undefined)?.delta
        const piece = delta?.text ?? delta?.thinking ?? delta?.partial_json ?? delta
        return typeof piece === 'string' ? piece : ''
      })
      .join('')
      .replaceAll(/\s+/gu, ' ')
      .trim(),
  )
  return (
    <Show
      when={props.list.length > 1}
      fallback={
        <Node
          label={props.name}
          path={path()}
          value={parse(props.list[0].data) ?? props.list[0].data}
        />
      }
    >
      <Fold
        name={`Inspect ${path()} events`}
        label={
          <>
            <span class="text-muted-foreground">{props.name}</span>
            <span class="shrink-0 text-foreground/90">× {props.list.length}</span>
            <span class="min-w-0 flex-1 truncate text-muted-foreground/60">{hint()}</span>
          </>
        }
      >
        <For each={props.list} keyed={false}>
          {(event, index) => (
            <Node
              label={`[${index}]`}
              path={`${path()}[${index}]`}
              value={parse(event().data) ?? event().data}
            />
          )}
        </For>
      </Fold>
    </Show>
  )
}

function Usage(props: { usage: WireUsage }) {
  const prompt = () => props.usage.input + props.usage.cacheRead + props.usage.cacheWrite
  const cells = createMemo(() => [
    { label: 'cache read', tokens: props.usage.cacheRead, tone: 'bg-brand/60' },
    {
      label: 'cache write',
      tokens: props.usage.cacheWrite,
      tone: 'bg-warning/70',
    },
    {
      label: 'input',
      tokens: props.usage.input,
      tone: 'bg-muted-foreground/50',
    },
  ])
  return (
    <div class="flex flex-col gap-2 px-1 py-1.5">
      <Show when={prompt() > 0}>
        <span aria-hidden="true" class="flex h-1 overflow-hidden rounded-full bg-muted">
          <For each={cells()} keyed={(cell) => cell.label}>
            {(cell) => (
              <Show when={cell().tokens > 0}>
                <span
                  class={cell().tone}
                  style={{ width: `${(cell().tokens / prompt()) * 100}%` }}
                />
              </Show>
            )}
          </For>
        </span>
      </Show>
      <div class="flex flex-wrap gap-x-5 gap-y-1">
        <For each={cells()} keyed={(cell) => cell.label}>
          {(cell) => (
            <span class="flex items-center gap-1.5">
              <span class={`size-2 rounded-[2px] ${cell().tone}`} />
              <span class="text-muted-foreground">{cell().label}</span>
              <span class="text-foreground/90 tabular-nums" title={cell().tokens.toLocaleString()}>
                {formatTokens(cell().tokens)}
              </span>
            </span>
          )}
        </For>
        <span class="flex items-center gap-1.5">
          <span class="text-muted-foreground">output</span>
          <span class="text-foreground/90 tabular-nums">{formatTokens(props.usage.output)}</span>
        </span>
      </div>
    </div>
  )
}

function ResponseBody(props: { text: string }) {
  const stream = createMemo(() => events(props.text))
  return (
    <Show
      when={stream().length > 0}
      fallback={
        <Part size={props.text.length} title="body">
          <TextBlock text={props.text} />
        </Part>
      }
    >
      <Part
        note={`${plural(stream().length, 'event')} · as received`}
        size={props.text.length}
        title="event stream"
      >
        <For each={runs(stream())} keyed={false}>
          {(run, index) => <Run index={index} list={run().events} name={run().name} />}
        </For>
      </Part>
    </Show>
  )
}

export function ReadableResponse(props: { call: WireCall }) {
  const relay = () => props.call.source === 'relay'
  const message = () => props.call.message as Json
  return (
    <>
      <Show when={props.call.failure}>
        {(failure) => (
          <Part title="failure">
            <TextBlock class="text-error" text={failure()} />
          </Part>
        )}
      </Show>
      <Show when={props.call.usage}>
        {(usage) => (
          <Part title="usage">
            <Usage usage={usage()} />
          </Part>
        )}
      </Show>
      <Show when={props.call.responseHeaders}>
        {(headers) => (
          <Headers
            headers={headers()}
            name="Response headers"
            note={`${props.call.status ?? ''} · ${Object.keys(headers()).length}`}
          />
        )}
      </Show>
      <Show when={props.call.message !== undefined}>
        <Part
          note={relay() ? 'as the relay assembled it from the stream' : 'assembled by Pi'}
          size={JSON.stringify(message()).length}
          title="message"
        >
          <Show
            when={isBranch(message()) && (message() as JsonObject | Json[])}
            fallback={<Node label="message" path="message" value={message()} />}
          >
            {(value) => <Children path="message" value={value()} />}
          </Show>
        </Part>
      </Show>
      <Show when={props.call.response !== undefined}>
        <ResponseBody text={props.call.response!} />
      </Show>
      <Show when={!relay()}>
        <p class="mt-5 text-muted-foreground/70">
          {props.call.provider}'s transport bytes and headers stay inside pi-ai; this is the message
          Pi assembled from them.
        </p>
      </Show>
    </>
  )
}

export function RawResponse(props: { call: WireCall }) {
  return (
    <Show
      when={props.call.response !== undefined}
      fallback={<Raw text={JSON.stringify(props.call.message ?? null)} />}
    >
      <RawBlock text={props.call.response!} />
    </Show>
  )
}
