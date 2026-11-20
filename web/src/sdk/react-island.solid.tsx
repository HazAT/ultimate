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
  onSettled,
  untrack,
  useContext,
} from 'solid-js'
import type { Accessor, Component } from 'solid-js'
import type { ReactNode } from 'react'
import { islandSolid } from './island-mark.ts'
import { chain, contribution, provided, reactRoot, renderedPoint, slot } from './react-island.tsx'
import type { Rendered } from './react-island.tsx'
import { ConversationScope, ExtensionName, Transcript } from './solid.ts'
import type { Point, SlotName } from './types.ts'

function MountReact(props: { render: () => ReactNode }) {
  const host = (<div class="contents data-empty:hidden" />) as HTMLDivElement
  const root = reactRoot(host, {
    conversation: useContext(ConversationScope) ?? undefined,
    transcript: useContext(Transcript) ?? undefined,
  })
  const markEmpty = () => host.toggleAttribute('data-empty', !host.hasChildNodes())
  onCleanup(root.unmount)
  onSettled(() => {
    const children = new MutationObserver(markEmpty)
    children.observe(host, { childList: true })
    return () => children.disconnect()
  })
  createEffect(
    () => props.render(),
    (element) => {
      root.render(element)
      markEmpty()
    },
  )
  return host
}

const solidHost = (children: () => JSX.Element) => {
  const host = document.createElement('div')
  host.className = 'contents'
  insert(host, children)
  return host
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
  const item = createMemo(() => props.item, {
    equals: (a, b) => a.component === b.component && a.extension === b.extension,
  })
  return (
    <For each={[item()]}>
      {(current) => {
        const Solid = islandSolid(current.component) as Component<Props> | undefined
        if (!Solid) return <MountReact render={() => contribution(item(), { ...props.props })} />
        return (
          <Errored fallback={(error) => props.fallback(current.extension, error())}>
            <ExtensionName value={current.extension}>
              <Solid {...props.props} />
            </ExtensionName>
          </Errored>
        )
      }}
    </For>
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
  const value = createMemo(input, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) })
  const [found, setFound] = createSignal<Value | undefined>()
  const root = reactRoot(document.createElement('div'), {
    conversation: useContext(ConversationScope) ?? undefined,
    transcript: useContext(Transcript) ?? undefined,
  })
  onCleanup(root.unmount)
  createEffect(value, (next) =>
    root.render(provided(point, next, (latest) => setFound(() => latest))),
  )
  return found
}
