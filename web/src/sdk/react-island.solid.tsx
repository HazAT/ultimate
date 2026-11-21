/** @jsxImportSource @solidjs/web */
import { Dynamic, insert, registerDelegatedRoot, unregisterDelegatedRoot } from '@solidjs/web'
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
  Show,
  untrack,
  useContext,
} from 'solid-js'
import type { Accessor, Component } from 'solid-js'
import type { ReactNode } from 'react'
import { nextTurn } from '../../../lib/timers.ts'
import { islandSolid } from './island-mark.ts'
import {
  ReactNodeView,
  allProvided,
  chain,
  contribution,
  icon,
  provided,
  reactRoot,
} from './react-island.tsx'
import type { Rendered, SolidPart } from './react-island.tsx'
import { provisionsOf, slotItems } from './registry.ts'
import { ConversationScope, ExtensionName, Transcript, useExtensions } from './solid.ts'
import type { Point, SlotName } from './types.ts'

type MountProps = { render: () => ReactNode }

function MountReact(props: MountProps) {
  return mountReact((<div class="contents data-empty:hidden" />) as HTMLElement, props)
}

export function ReactValue(props: { value: ReactNode }) {
  const extension = useContext(ExtensionName) ?? 'react'
  return (
    <Contribution
      fallback={() => null}
      item={{ component: ReactNodeView, extension, version: 0 }}
      props={{ value: props.value }}
    />
  )
}

function MountReactInline(props: MountProps) {
  return mountReact((<span class="contents data-empty:hidden" />) as HTMLElement, props)
}

function mountReact(host: HTMLElement, props: MountProps) {
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
  fallback: (extension: string, error: unknown, stack?: string) => JSX.Element
  variant?: 'inline' | 'block'
  fallbackOnly?: boolean
  inline?: boolean
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
          const [failure, setFailure] = createSignal<{
            error: unknown
            stack?: string
            version: number
          }>()
          const onError = (error: unknown, stack: string | undefined) =>
            setFailure({ error, stack, version: props.item.version })
          const shownFailure = () => {
            const failed = failure()
            return failed?.version === props.item.version ? failed : undefined
          }
          const render = () =>
            contribution(props.item, { ...props.props }, parts, undefined, {
              variant: props.variant,
              onError: props.fallbackOnly ? onError : undefined,
            })
          return (
            <>
              <Show when={props.inline} fallback={<MountReact render={render} />}>
                <MountReactInline render={render} />
              </Show>
              <Show when={shownFailure()}>
                {(failed) => props.fallback(current.extension, failed().error, failed().stack)}
              </Show>
            </>
          )
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

export function Slot(props: {
  name: SlotName
  fallback: (extension: string, error: unknown, stack?: string) => JSX.Element
  variant?: 'inline' | 'block'
  phone?: boolean
  fallbackOnly?: boolean
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
      {(item) => (
        <Contribution
          fallback={props.fallback}
          fallbackOnly={props.fallbackOnly}
          inline={props.variant === 'inline'}
          item={item()}
          props={{}}
          variant={props.variant}
        />
      )}
    </For>
  )
}

export function RenderedPoint<Input extends object>(props: {
  point: Point<Input & { core: ReactNode }, ReactNode>
  input: Input
  core: () => JSX.Element
  fallback: (extension: string, error: unknown, inner: () => JSX.Element) => JSX.Element
}) {
  const extensions = useExtensions()
  const renderers = createMemo(() =>
    provisionsOf(extensions(), props.point.point).map((provision) => ({
      extension: provision.extension,
      version: provision.version,
      component: hookAsComponent(provision.use),
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

const hookComponents = new WeakMap<object, (props: object) => ReactNode>()
const hookAsComponent = (use: unknown) => {
  if (islandSolid(use)) return use
  const hook = use as (input: object) => ReactNode
  let component = hookComponents.get(hook)
  if (!component) {
    component = (input: object) => hook(input)
    hookComponents.set(hook, component)
  }
  return component
}

export function ContributedIcon(props: { icon: unknown; class: string }) {
  return (
    <Show
      when={islandSolid(props.icon) as Component<{ class?: string }> | undefined}
      fallback={<MountReactInline render={() => icon(props.icon, props.class)} />}
    >
      {(Solid) => <Dynamic class={props.class} component={Solid()} />}
    </Show>
  )
}

function useReactReport<Input, Found>(
  input: Accessor<Input>,
  initial: Found,
  element: (input: Input, report: (found: Found) => void) => ReactNode,
  host: HTMLElement = document.createElement('div'),
): Accessor<Found> {
  const value = createMemo(input, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) })
  const [found, setFound] = createSignal<Found>(() => initial)
  const root = reactRoot(host, {
    conversation: useContext(ConversationScope) ?? undefined,
    transcript: useContext(Transcript) ?? undefined,
  })
  onCleanup(() => nextTurn(root.unmount))
  createEffect(value, (next) => root.render(element(next, (latest) => setFound(() => latest))))
  return found
}

export const useProvided = <Input, Value>(
  point: Point<Input, Value>,
  input: Accessor<Input>,
  failures?: HTMLElement,
) =>
  useReactReport<Input, Value | undefined>(
    input,
    undefined,
    (next, report) => provided(point, next, report),
    failures,
  )

export const useAllProvided = <Input, Value>(
  point: Point<Input, Value>,
  input: Accessor<Input>,
  failures?: HTMLElement,
) =>
  useReactReport<Input, readonly Value[]>(
    input,
    [],
    (next, report) => allProvided(point, next, report),
    failures,
  )
