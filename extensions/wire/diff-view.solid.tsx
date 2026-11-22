import { For, Show, createMemo } from 'solid-js'
import { cn, formatBytes, useAction } from '@/sdk/solid'
import { parse } from './json.ts'
import { DiffAction } from './refs.ts'
import type { WireDiff, WireSummary } from './refs.ts'
import { Fold, Node, Part } from './tree.solid.tsx'

function PrefixBar(props: { diff: WireDiff; added: number }) {
  const total = () => props.diff.prefixBytes + props.added
  return (
    <Show when={total() > 0}>
      <span aria-hidden="true" class="flex h-1.5 overflow-hidden rounded-full bg-muted">
        <span
          class="bg-brand/60"
          style={{ width: `${(props.diff.prefixBytes / total()) * 100}%` }}
        />
        <span
          class={props.diff.firstChange ? 'bg-warning/70' : 'bg-muted-foreground/40'}
          style={{ width: `${(props.added / total()) * 100}%` }}
        />
      </span>
    </Show>
  )
}

function Side(props: { label: string; text: string; lead: string; tone: string }) {
  return (
    <div class="flex gap-2">
      <span class="w-12 shrink-0 text-muted-foreground/70">{props.label}</span>
      <span class="min-w-0 break-all whitespace-pre-wrap">
        <span class="text-muted-foreground/60">{props.lead}</span>
        <span class={cn('rounded-[2px] px-px', props.tone)}>{props.text || '∅'}</span>
        {props.text.length >= 160 && <span class="text-muted-foreground/60">…</span>}
      </span>
    </div>
  )
}

function Break(props: { change: NonNullable<WireDiff['firstChange']> }) {
  const lead = () => (props.change.lead.length >= 160 ? `…${props.change.lead}` : props.change.lead)
  return (
    <section class="rounded-md border border-warning/30 bg-warning/5 px-3 py-2.5">
      <div class="flex flex-wrap items-baseline gap-x-2 text-warning">
        <span>prefix breaks at</span>
        <span class="text-foreground">{props.change.path}</span>
        <span class="text-muted-foreground">
          · character {props.change.offset.toLocaleString()}
        </span>
      </div>
      <p class="mt-1 font-sans text-[12.5px] text-muted-foreground">
        Everything from here on is written to the cache again, though most of it was sent before.
      </p>
      <div class="mt-2.5 flex flex-col gap-1.5 rounded-sm bg-terminal px-2.5 py-2 text-[11.5px] leading-[1.55]">
        <Side
          label="before"
          lead={lead()}
          text={props.change.before}
          tone="bg-diff-del/20 text-diff-del"
        />
        <Side
          label="after"
          lead={lead()}
          text={props.change.after}
          tone="bg-diff-add/20 text-diff-add"
        />
      </div>
    </section>
  )
}

function Removed(props: { paths: string[] }) {
  return (
    <Fold
      name="Inspect replaced paths"
      panelClass="flex flex-col pl-6"
      label={
        <span class="min-w-0 truncate text-muted-foreground">
          {props.paths.slice(0, 6).join(', ')}
          {props.paths.length > 6 ? ` … ${props.paths.length - 6} more` : ''}
        </span>
      }
    >
      <For each={props.paths}>{(path) => <span class="text-diff-del/90">{path}</span>}</For>
    </Fold>
  )
}

function Body(props: { diff: WireDiff; previous?: WireSummary }) {
  const pure = () => !props.diff.firstChange
  const added = createMemo(() =>
    props.diff.added.reduce((sum, segment) => sum + segment.json.length, 0),
  )
  return (
    <>
      <section class="flex flex-col gap-2">
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span class={pure() ? 'text-foreground/90' : 'text-warning'}>
            {pure() ? 'pure append: the cached prefix held' : 'prefix changed'}
          </span>
          <span class="text-muted-foreground/70">
            vs #{props.diff.previous}
            {props.previous ? ` · ${props.previous.model}` : ''}
          </span>
        </div>
        <PrefixBar added={added()} diff={props.diff} />
        <div class="flex flex-wrap gap-x-5 gap-y-1 text-muted-foreground">
          <span class="flex items-center gap-1.5">
            <span class="size-2 rounded-[2px] bg-brand/60" />
            unchanged{' '}
            <span class="text-foreground/90 tabular-nums">
              {props.diff.same} of {props.diff.segments}
            </span>{' '}
            segments · {formatBytes(props.diff.prefixBytes)}
          </span>
          <span class="flex items-center gap-1.5">
            <span
              class={cn(
                'size-2 rounded-[2px]',
                pure() ? 'bg-muted-foreground/40' : 'bg-warning/70',
              )}
            />
            {pure() ? 'appended' : 'from the break on'}{' '}
            <span class="text-foreground/90 tabular-nums">{props.diff.added.length}</span> ·{' '}
            {formatBytes(added())}
          </span>
        </div>
      </section>
      <Show when={props.diff.firstChange}>
        {(change) => (
          <div class="mt-5">
            <Break change={change()} />
          </div>
        )}
      </Show>
      <Show when={props.diff.settings.length > 0}>
        <Part note="outside the prefix" title="settings changed">
          <div class="flex flex-col gap-0.5 px-1 py-1">
            <For each={props.diff.settings} keyed={(setting) => setting.key}>
              {(setting) => (
                <div class="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span class="w-40 shrink-0 truncate text-muted-foreground">{setting().key}</span>
                  <span class="text-diff-del">{setting().before ?? '∅'}</span>
                  <span class="text-muted-foreground/60">→</span>
                  <span class="text-diff-add">{setting().after ?? '∅'}</span>
                </div>
              )}
            </For>
          </div>
        </Part>
      </Show>
      <Show when={props.diff.added.length > 0}>
        <Part
          note={pure() ? 'new at the end' : 'sent again from the break on'}
          size={added()}
          title={pure() ? 'appended' : 'from the break'}
        >
          <For each={props.diff.added} keyed={(segment) => segment.path}>
            {(segment) => {
              const value = createMemo(() => {
                const text = segment().json
                const parsed = parse(text)
                return parsed === undefined ? text : parsed
              })
              return <Node label={segment().path} path={segment().path} value={value()} />
            }}
          </For>
        </Part>
      </Show>
      <Show when={props.diff.removed.length > 0}>
        <Part note={`in #${props.diff.previous} from the break on`} title="replaced">
          <Removed paths={props.diff.removed} />
        </Part>
      </Show>
    </>
  )
}

function noDiff(call: WireSummary, previous?: WireSummary) {
  if (!previous)
    return 'The first call kept for this conversation: nothing earlier to compare with.'
  if (previous.api !== call.api)
    return `#${previous.n} went to ${previous.api ?? previous.provider}, this one to ${call.api ?? call.provider}: a different body, so a different cache. Nothing to compare.`
  return `#${previous.n}'s body could not be compared.`
}

export function DiffView(props: { call: WireSummary; calls: WireSummary[] }) {
  const diff = useAction(DiffAction, {
    get n() {
      return props.call.n
    },
  })
  const previous = createMemo(() => {
    const n = props.call.n
    return props.calls.findLast((other) => other.n < n)
  })
  return (
    <Show
      when={diff.data()}
      fallback={
        <p class="text-muted-foreground/70">
          {diff.loading() || diff.data() === undefined
            ? 'comparing…'
            : noDiff(props.call, previous())}
        </p>
      }
    >
      {(data) => <Body diff={data()} previous={previous()} />}
    </Show>
  )
}
