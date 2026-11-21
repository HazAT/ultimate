import type { ConversationId } from '@earendil-works/pi-durable'
import type { TranscriptFrame } from './transcript-frame.ts'

export type Rendered = { extension: string; version: number; component: unknown }
export type Placement = { conversation?: ConversationId; transcript?: TranscriptFrame }
export type SolidPart = { mount: (host: HTMLElement, placed: Placement) => () => void }
export type Failure = {
  variant?: 'inline' | 'block'
  onError?: (error: unknown, stack: string | undefined) => void
}

/** What the core asks of the React compat layer (`web/src/compat/bridge.tsx`); React elements stay opaque here. */
export interface ReactBridge {
  root(
    host: HTMLElement,
    placed: Placement,
  ): { render: (element: unknown) => void; unmount: () => void }
  contribution(
    item: Rendered,
    props: object,
    parts: Record<string, SolidPart>,
    failure: Failure,
  ): unknown
  chain(run: readonly Rendered[], props: object, core: SolidPart): unknown
  icon(component: unknown, className: string): unknown
  node(value: unknown): unknown
  provision(
    item: Omit<Rendered, 'component'> & { use: unknown },
    input: unknown,
    report: (value: unknown) => void,
  ): unknown
}

const reactParts = new WeakSet<object>()
const solidOfIsland = new WeakMap<object, unknown>()

export const markIsland = (island: object, component: unknown) =>
  solidOfIsland.set(island, component)

export const markReact = (part: object) => reactParts.add(part)

/**
 * The Solid component behind a contribution: itself from a `web.solid.tsx`, the component an `island(C)` wraps from a
 * `web.tsx`, undefined for a React one.
 */
export const solidOf = (part: unknown) =>
  (typeof part === 'function' || typeof part === 'object') && part !== null && reactParts.has(part)
    ? solidOfIsland.get(part)
    : part

export const isReact = (part: unknown) => solidOf(part) === undefined

/** A React element or a list holding one, as a React provider returns UI. */
export const isReactNode = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.some(isReactNode)
    : typeof value === 'object' && value !== null && '$$typeof' in value

let bridge: ReactBridge | undefined

/** Loads the React compat layer; the registry awaits it before it installs a `web.tsx`. */
export const loadReact = async () => {
  bridge ??= (await import('../compat/bridge.tsx')).bridge
}

export function reactBridge() {
  if (!bridge) throw new Error('A React contribution rendered before the compat layer loaded')
  return bridge
}
