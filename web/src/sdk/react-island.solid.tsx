/** @jsxImportSource @solidjs/web */
import { insert } from '@solidjs/web'
import type { JSX } from '@solidjs/web'
import {
  createEffect,
  createMemo,
  createSignal,
  Errored,
  For,
  onCleanup,
  Show,
  untrack,
  useContext,
} from 'solid-js'
import type { Accessor, Component } from 'solid-js'
import type { ComponentType, ReactNode } from 'react'
import { islandSolid } from './island-mark.ts'
import { chain, contribution, provisions, reactRoot, renderedPoint, slot } from './react-island.tsx'
import type { Rendered } from './react-island.tsx'
import { provisionOf, provisionsOf } from './registry.ts'
import type { ExtensionRecord } from './registry.ts'
import { ConversationScope, ExtensionName, Transcript, useExtensions } from './solid.ts'
import type { Point, SlotName } from './types.ts'

function MountReact(props: { render: () => ReactNode }) {
  const host = (<div class="contents" />) as HTMLDivElement
  const root = reactRoot(host, {
    conversation: useContext(ConversationScope) ?? undefined,
    transcript: useContext(Transcript) ?? undefined,
  })
  onCleanup(root.unmount)
  createEffect(
    () => props.render(),
    (element) => root.render(element),
  )
  return host
}

const solidHost = (children: () => JSX.Element) => {
  const host = document.createElement('div')
  host.className = 'contents'
  insert(host, children)
  return host
}

/**
 * Temporary, for the core switch: C5 deletes it with React. The reverse of `island`: a Solid component that mounts the
 * React `component` in place, re-rendering it with each change of the Solid props without a remount. It renders inside
 * an `ExtensionName`. Only the core hosts in `web/src/app` import it.
 */
export function reactIsland<P extends object = Record<string, never>>(
  component: ComponentType<P>,
): Component<P> {
  return function ReactIsland(props: P) {
    const extension = useContext(ExtensionName)
    if (extension === null) throw new Error('reactIsland renders only inside an ExtensionName')
    return (
      <MountReact render={() => contribution({ extension, version: 0, component }, { ...props })} />
    )
  }
}

type Props = Record<string, unknown>
type Fallback = (extension: string, error: unknown, inner: () => JSX.Element) => JSX.Element
type Link = { solid?: Component<Props>; run: readonly Rendered[]; extension: string }

const linksOf = (renderers: readonly Rendered[]): Link[] => {
  const links: Link[] = []
  for (const renderer of renderers) {
    const solid = islandSolid(renderer.component) as Component<Props> | undefined
    const previous = links.at(-1)
    if (solid) links.push({ solid, run: [], extension: renderer.extension })
    else if (previous && !previous.solid) previous.run = [...previous.run, renderer]
    else links.push({ run: [renderer], extension: renderer.extension })
  }
  return links
}

const sameLinks = (a: readonly Link[], b: readonly Link[]) =>
  a.length === b.length &&
  a.every(
    (link, index) =>
      link.solid === b[index].solid &&
      link.run.length === b[index].run.length &&
      link.run.every(
        (item, at) =>
          item.component === b[index].run[at].component &&
          item.version === b[index].run[at].version,
      ),
  )

export function Contributed(props: {
  renderers: readonly Rendered[]
  props: Props
  core: () => JSX.Element
  fallback: Fallback
}) {
  const links = createMemo(() => linksOf(props.renderers), { equals: sameLinks })
  const wrap = (index: number): JSX.Element => {
    if (index < 0) return props.core()
    const link = untrack(links)[index]
    const inner = () => wrap(index - 1)
    if (!link.solid) {
      const run = link.run
      const core = solidHost(inner)
      return <MountReact render={() => chain(run, { ...props.props }, core)} />
    }
    const Solid = link.solid
    return (
      <Errored fallback={(error) => props.fallback(link.extension, error(), inner)}>
        <ExtensionName value={link.extension}>
          <Solid {...props.props} core={inner()} />
        </ExtensionName>
      </Errored>
    )
  }
  return <For each={[links()]}>{(current) => wrap(current.length - 1)}</For>
}

export function Contribution(props: {
  item: Rendered
  props: Props
  fallback: (extension: string, error: unknown) => JSX.Element
}) {
  const solid = createMemo(() => islandSolid(props.item.component) as Component<Props> | undefined)
  return (
    <Show
      when={solid()}
      fallback={<MountReact render={() => contribution(props.item, { ...props.props })} />}
    >
      {(Solid) => {
        const Rendered = Solid()
        return (
          <Errored fallback={(error) => props.fallback(props.item.extension, error())}>
            <ExtensionName value={props.item.extension}>
              <Rendered {...props.props} />
            </ExtensionName>
          </Errored>
        )
      }}
    </Show>
  )
}

export function ReactSlot(props: { name: SlotName }) {
  return <MountReact render={() => slot(props.name)} />
}

export function RenderedPoint<Input extends object>(props: {
  point: Point<Input & { core: ReactNode }, ReactNode>
  input: Input
  staticCore: () => JSX.Element
}) {
  const core = solidHost(props.staticCore)
  return <MountReact render={() => renderedPoint(props.point, { ...props.input }, core)} />
}

export function useProvided<Input, Value>(
  point: Point<Input, Value>,
  input: Accessor<Input>,
): Accessor<Value | undefined> {
  const values = provided(input, (records) => {
    const last = provisionOf(records, point.point)
    return last ? [last] : []
  })
  return () => values()[0] as Value | undefined
}

export function useAllProvided<Input, Value>(
  point: Point<Input, Value>,
  input: Accessor<Input>,
): Accessor<readonly Value[]> {
  return provided(input, (records) => provisionsOf(records, point.point)) as Accessor<
    readonly Value[]
  >
}

function provided(
  input: Accessor<unknown>,
  which: (records: readonly ExtensionRecord[]) => ReturnType<typeof provisionsOf>,
): Accessor<readonly unknown[]> {
  const records = useExtensions()
  const current = createMemo(() => which(records()))
  const value = createMemo(input, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) })
  const [values, setValues] = createSignal<readonly unknown[]>([])
  const root = reactRoot(document.createElement('div'), {
    conversation: useContext(ConversationScope) ?? undefined,
    transcript: useContext(Transcript) ?? undefined,
  })
  onCleanup(root.unmount)
  createEffect(
    () => ({ providers: current(), input: value() }),
    ({ providers, input: next }) =>
      root.render(provisions(providers, next, (found) => setValues(found))),
  )
  return values
}
