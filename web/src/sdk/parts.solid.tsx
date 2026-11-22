/** @jsxImportSource @solidjs/web */
import type { Entry, TypedEntry } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord/json'
import { createMemo, For, onCleanup, Show } from 'solid-js'
import type { JSX } from '@solidjs/web'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { Component } from 'solid-js'
import { ContributionError } from '../app/contribution-error.solid.tsx'
import { Contribution, Slot as BridgeSlot } from './contribution.solid.tsx'
import { isReact } from './framework.ts'
import { store } from './client.ts'
import { scopeAttribute } from './scope.ts'
import { ConversationScope, provisionsOf, Transcript, useExtensions } from './hooks.ts'
import type { Point, SlotName, SolidEntryProps } from './types.ts'

/** Any slot by name, each item isolated: one that throws shows its error card inline and the rest still render. */
export function Slot(props: { name: SlotName; variant?: 'inline' | 'block' }) {
  return (
    <BridgeSlot
      fallback={(extension, error) => (
        <ContributionError
          error={error}
          extension={extension}
          inline={props.variant === 'inline'}
        />
      )}
      name={props.name}
      variant={props.variant}
    />
  )
}

/**
 * Renders what each extension provides for `point` with `input`, in discovery order (`last` keeps only the last
 * provider). A Solid provider is a component taking the live input as its props; a React provider's hook renders
 * through the compat layer with a copy of the input taken whenever any of it changes. A provider that throws shows its
 * error inline and the rest still render.
 */
export function Provided<Input extends object>(props: {
  point: Point<Input, unknown>
  input: Input
  last?: boolean
}) {
  const extensions = useExtensions()
  const items = createMemo(() => {
    const all = provisionsOf(extensions(), props.point.point).map((provision) => ({
      extension: provision.extension,
      version: provision.version,
      component: provision.use,
    }))
    return props.last ? all.slice(-1) : all
  })
  const copy = createMemo(() => readDeeply(props.input) as Record<string, unknown>)
  return (
    <For each={items()} keyed={(item) => `${item.extension}:${item.version}`}>
      {(item) => (
        <Show
          fallback={<Provider item={item()} input={copy()} />}
          when={!isReact(item().component)}
        >
          <Provider item={item()} input={props.input as Record<string, unknown>} />
        </Show>
      )}
    </For>
  )
}

const plain = (value: unknown): value is object =>
  Array.isArray(value) ||
  (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype)

function readDeeply(value: unknown): unknown {
  if (!plain(value)) return value
  if (Array.isArray(value)) return value.map(readDeeply)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, readDeeply(item)]))
}

function Provider(props: {
  item: { extension: string; version: number; component: unknown }
  input: Record<string, unknown>
}) {
  return (
    <Contribution
      fallback={(extension, error) => (
        <ContributionError error={error} extension={extension} inline />
      )}
      item={props.item}
      props={props.input}
    />
  )
}

/**
 * Narrows an entry renderer's entry with its writer's token: `Card` renders a matching entry, any other renders `core`.
 * Contribute it as `entries: { 'my.kind': renderEntry(Token, Card) }`.
 */
export function renderEntry<D extends JsonValue>(
  token: Entry<D>,
  Card: Component<Omit<SolidEntryProps, 'entry'> & { entry: TypedEntry<D> }>,
): Component<SolidEntryProps> {
  return function TypedEntryRenderer(props) {
    const typed = createMemo(() => (token.is(props.entry) ? props.entry : undefined))
    return (
      <Show when={typed()} fallback={props.core}>
        {(entry) => <Card blocks={props.blocks} core={props.core} entry={entry()} />}
      </Show>
    )
  }
}

/**
 * Gives `children` their own live conversation `id` without switching the shown one: the SDK readers, the transcript and
 * composer inside follow it, and so do shortcuts pressed inside it. Scopes of the same id share one stream, released when
 * the last one unmounts.
 */
export function ScopedConversation(props: { id: ConversationId; children: JSX.Element }) {
  return <For each={[props.id]}>{(id) => scope(id, () => props.children)}</For>
}

function scope(id: ConversationId, children: () => JSX.Element) {
  onCleanup(store.watchConversation(id))
  return (
    <ConversationScope value={id}>
      <Transcript value={null}>
        <div class="contents" {...{ [scopeAttribute]: id }}>
          {children()}
        </div>
      </Transcript>
    </ConversationScope>
  )
}
