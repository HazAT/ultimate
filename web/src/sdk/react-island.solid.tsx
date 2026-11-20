/** @jsxImportSource @solidjs/web */
import { insert, registerDelegatedRoot, unregisterDelegatedRoot } from '@solidjs/web'
import type { JSX } from '@solidjs/web'
import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  Errored,
  For,
  getOwner,
  onCleanup,
  onSettled,
  runWithOwner,
  untrack,
  useContext,
} from 'solid-js'
import type { Accessor, Component } from 'solid-js'
import type { ReactNode } from 'react'
import { nextTurn } from '../../../lib/timers.ts'
import { islandSolid } from './island-mark.ts'
import {
  allProvided,
  chain,
  contribution,
  provided,
  reactRoot,
  renderedPoint,
  slot,
} from './react-island.tsx'
import type { Rendered, SolidPart } from './react-island.tsx'
import { slotItems } from './registry.ts'
import { ConversationScope, ExtensionName, Transcript, useExtensions } from './solid.ts'
import type { Point, SlotName } from './types.ts'

function MountReact(props: { render: () => ReactNode }) {
  const host = (<div class="contents data-empty:hidden" />) as HTMLDivElement
  const root = reactRoot(host, {
    conversation: useContext(ConversationScope) ?? undefined,
    transcript: useContext(Transcript) ?? undefined,
  })
  const markEmpty = () => host.toggleAttribute('data-empty', !host.hasChildNodes())
  onCleanup(() => nextTurn(root.unmount))
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

const solidPart = (children: () => JSX.Element): SolidPart => {
  const owner = getOwner()
  const scoped = useContext(ConversationScope)
  return {
    mount: (host, placed) => {
      const rescoped = placed.conversation !== undefined && placed.conversation !== scoped
      const framed = () =>
        placed.transcript ? (
          <Transcript value={placed.transcript}>{children()}</Transcript>
        ) : rescoped ? (
          <Transcript value={null}>{children()}</Transcript>
        ) : (
          children()
        )
      const view = () =>
        rescoped ? (
          <ConversationScope value={placed.conversation!}>{framed()}</ConversationScope>
        ) : (
          framed()
        )
      let dispose: (() => void) | undefined
      const release = () => {
        try {
          dispose?.()
        } finally {
          unregisterDelegatedRoot(host)
          host.textContent = ''
        }
      }
      registerDelegatedRoot(host)
      try {
        runWithOwner(owner, () =>
          createRoot((done) => {
            dispose = done
            insert(host, view)
          }),
        )
      } catch (failure) {
        release()
        throw failure
      }
      return release
    },
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
      const core = solidPart(inner)
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
  elements?: Record<string, () => JSX.Element>
  fallback: (extension: string, error: unknown) => JSX.Element
}) {
  const mounted = createMemo(() => props.item, {
    equals: (a, b) => a.component === b.component && a.extension === b.extension,
  })
  return (
    <For each={[mounted()]}>
      {(current) => {
        const Solid = islandSolid(current.component) as Component<Props> | undefined
        const elements = props.elements ?? {}
        if (!Solid) {
          const parts = Object.fromEntries(
            Object.entries(elements).map(([key, element]) => [key, solidPart(element)]),
          )
          return <MountReact render={() => contribution(props.item, { ...props.props }, parts)} />
        }
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

export function ReactSlot(props: { name: SlotName }) {
  return <MountReact render={() => slot(props.name)} />
}

export function Slot(props: {
  name: SlotName
  fallback: (extension: string, error: unknown) => JSX.Element
}) {
  const extensions = useExtensions()
  const items = createMemo(() => slotItems(extensions(), props.name), {
    equals: (a, b) =>
      a.length === b.length &&
      a.every((item, at) => item.key === b[at].key && item.version === b[at].version),
  })
  return (
    <For each={items()} keyed={(item) => `${item.key}:${item.version}`}>
      {(item) => <Contribution fallback={props.fallback} item={item()} props={{}} />}
    </For>
  )
}

export function RenderedPoint<Input extends object>(props: {
  point: Point<Input & { core: ReactNode }, ReactNode>
  input: Input
  staticCore: () => JSX.Element
}) {
  const core = solidPart(props.staticCore)
  return <MountReact render={() => renderedPoint(props.point, { ...props.input }, core)} />
}

function useReactReport<Input, Found>(
  input: Accessor<Input>,
  initial: Found,
  element: (input: Input, report: (found: Found) => void) => ReactNode,
): Accessor<Found> {
  const value = createMemo(input, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) })
  const [found, setFound] = createSignal<Found>(() => initial)
  const root = reactRoot(document.createElement('div'), {
    conversation: useContext(ConversationScope) ?? undefined,
    transcript: useContext(Transcript) ?? undefined,
  })
  onCleanup(() => nextTurn(root.unmount))
  createEffect(value, (next) => root.render(element(next, (latest) => setFound(() => latest))))
  return found
}

export const useProvided = <Input, Value>(point: Point<Input, Value>, input: Accessor<Input>) =>
  useReactReport<Input, Value | undefined>(input, undefined, (next, report) =>
    provided(point, next, report),
  )

export const useAllProvided = <Input, Value>(point: Point<Input, Value>, input: Accessor<Input>) =>
  useReactReport<Input, readonly Value[]>(input, [], (next, report) =>
    allProvided(point, next, report),
  )
