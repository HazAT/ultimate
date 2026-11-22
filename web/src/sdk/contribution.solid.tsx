import { Dynamic, insert } from '@solidjs/web'
import type { JSX } from '@solidjs/web'
import {
  createEffect,
  createMemo,
  Errored,
  flatten,
  For,
  mapArray,
  onCleanup,
  Show,
} from 'solid-js'
import type { Accessor, Component } from 'solid-js'
import { ContributionError } from '../app/contribution-error.solid.tsx'
import { provisionsOf, slotItems } from './registry.ts'
import { ExtensionName, useExtensions } from './hooks.ts'
import type { Contribution as SlotContribution, Point, SlotName } from './types.ts'

export type Rendered = { extension: string; version: number; component: unknown }

type Props = Record<string, unknown>
type Fallback = (extension: string, error: unknown, inner: () => JSX.Element) => JSX.Element

const sameRenderers = (a: readonly Rendered[], b: readonly Rendered[]) =>
  a.length === b.length &&
  a.every((item, at) => item.component === b[at].component && item.extension === b[at].extension)

export function Contributed(props: {
  renderers: readonly Rendered[]
  props: Props
  core: () => JSX.Element
  fallback: Fallback
}) {
  const chain = createMemo(() => props.renderers, { equals: sameRenderers })
  const wrap = (links: readonly Rendered[], index: number): JSX.Element => {
    if (index < 0) return props.core()
    const link = links[index]
    const inner = () => wrap(links, index - 1)
    const Solid = link.component as Component<Props>
    return (
      <Errored fallback={(error) => props.fallback(link.extension, error(), inner)}>
        <ExtensionName value={link.extension}>
          <Solid {...props.props} core={inner()} />
        </ExtensionName>
      </Errored>
    )
  }
  return <For each={[chain()]}>{(current) => wrap(current, current.length - 1)}</For>
}

export type Contribution = SlotContribution

/**
 * One contribution in its extension's scope, isolated: a failure shows `fallback`. The parts it places (`core`,
 * `cancel`) go in `elements`.
 */
export function Contribution(props: {
  item: Rendered
  props: Props
  elements?: Record<string, () => JSX.Element>
  fallback: (extension: string, error: unknown, stack?: string) => JSX.Element
}) {
  const mounted = createMemo(() => props.item, {
    equals: (a, b) => a.component === b.component && a.extension === b.extension,
  })
  return (
    <For each={[mounted()]}>
      {(current) => {
        const Solid = current.component as Component<Props>
        const elements = props.elements ?? {}
        const solidElements = Object.fromEntries(
          Object.keys(elements).map((key) => [key, elements[key]()]),
        )
        return (
          <Errored fallback={(error) => props.fallback(current.extension, error())}>
            <ExtensionName value={current.extension}>
              <Solid {...props.props} {...solidElements} />
            </ExtensionName>
          </Errored>
        )
      }}
    </For>
  )
}

export function Slot(props: {
  name: SlotName
  fallback: (extension: string, error: unknown, stack?: string) => JSX.Element
  phone?: boolean
}) {
  const extensions = useExtensions()
  const items = createMemo(
    () =>
      slotItems(extensions(), props.name).filter(
        (item) => props.phone === undefined || item.phone === props.phone,
      ),
    {
      equals: (a, b) =>
        a.length === b.length &&
        a.every((item, at) => item.key === b[at].key && item.version === b[at].version),
    },
  )
  return (
    <For each={items()} keyed={(item) => `${item.key}:${item.version}`}>
      {(item) => <Contribution fallback={props.fallback} item={item()} props={{}} />}
    </For>
  )
}

export function RenderedPoint<Input extends object>(props: {
  point: Point<Input & { core: unknown }, unknown>
  input: Input
  core: () => JSX.Element
  fallback: (extension: string, error: unknown, inner: () => JSX.Element) => JSX.Element
}) {
  const extensions = useExtensions()
  const renderers = createMemo(() =>
    provisionsOf(extensions(), props.point.point).map((provision) => ({
      extension: provision.extension,
      version: provision.version,
      component: provision.use,
    })),
  )
  return (
    <Contributed
      core={props.core}
      fallback={props.fallback}
      props={props.input as Props}
      renderers={renderers()}
    />
  )
}

export function ContributedIcon(props: { icon: unknown; class: string }) {
  return <Dynamic class={props.class} component={props.icon as Component<{ class?: string }>} />
}

type Provider = { extension: string; version: number; use: unknown }

const sameProviders = (a: readonly Provider[], b: readonly Provider[]) =>
  a.length === b.length &&
  a.every((item, at) => item.use === b[at].use && item.version === b[at].version)

const failed = Symbol('failed provider')

function runProvider(use: unknown, input: Accessor<unknown>): Accessor<unknown> {
  try {
    return (use as (input: Accessor<unknown>) => Accessor<unknown>)(input)
  } catch (error) {
    return () => {
      throw error
    }
  }
}

function solidProviderValue(
  provider: Provider,
  input: Accessor<unknown>,
  failures: HTMLElement | undefined,
): Accessor<unknown> {
  const read = runProvider(provider.use, input)
  const outcome = createMemo(() => {
    try {
      return { value: read() }
    } catch (error) {
      return { error }
    }
  })
  createEffect(
    () => outcome().error,
    (error) => {
      if (error !== undefined) console.error(`[extension ${provider.extension}]`, error)
    },
  )
  if (failures) {
    const host = (<span class="contents" />) as HTMLElement
    failures.append(host)
    onCleanup(() => host.remove())
    insert(host, () => (
      <Show when={'error' in outcome()}>
        <ContributionError error={outcome().error} extension={provider.extension} inline />
      </Show>
    ))
  }
  return () => ('error' in outcome() ? failed : outcome().value)
}

function inExtension<T>(extension: string, run: () => T): T {
  let result!: T
  flatten(
    ExtensionName({
      value: extension,
      get children() {
        result = run()
        return undefined
      },
    }),
  )
  return result
}

function providerValue(
  provider: Provider,
  input: Accessor<unknown>,
  failures: HTMLElement | undefined,
): Accessor<unknown> {
  return inExtension(provider.extension, () => solidProviderValue(provider, input, failures))
}

export function useAllProvided<Input, Value>(
  point: Point<Input, Value>,
  input: Accessor<Input>,
  failures?: HTMLElement,
): Accessor<readonly Value[]> {
  const extensions = useExtensions()
  const providers = createMemo(() => provisionsOf(extensions(), point.point), {
    equals: sameProviders,
  })
  const values = mapArray(providers, (provider) =>
    providerValue(provider, input as Accessor<unknown>, failures),
  )
  return createMemo(
    () =>
      values()
        .map((value) => value())
        .filter((value) => value !== failed) as Value[],
  )
}

export function useProvided<Input, Value>(
  point: Point<Input, Value>,
  input: Accessor<Input>,
  failures?: HTMLElement,
): Accessor<Value | undefined> {
  const all = useAllProvided(point, input, failures)
  return () => all().at(-1)
}
