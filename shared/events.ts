import type { JsonValue } from '@earendil-works/chord/json'

/** Ids of the work an event happened in, from the call trace: a reactor's run continues `traceId` under `parentCall`. */
export type EventContext = {
  traceId?: string
  conversationId?: number
  taskId?: number
  entryId?: number
  parentCall?: string
}

/** One durable event as readers and reactors see it: `id` is its entry in the event log and gives one global order. */
export type EventRecord<D extends JsonValue = JsonValue> = {
  id: number
  name: string
  kind: string
  /** The version of the event's data shape when it was emitted. */
  v: number
  at: string
  data: D
  context?: EventContext
  /** The event this one fails (`defineEvent`'s `fails`): a wait on that event ends with this one as its error. */
  fails?: string
}

/** A typed event: `name` like `workspaces.landed`, stored as entry kind `event.<name>`. Plain data, browser-safe. */
export interface EventToken<D extends JsonValue = JsonValue> {
  readonly name: string
  readonly kind: string
  readonly version: number
  readonly fails?: string
  is(event: EventRecord | undefined): event is EventRecord<D>
}

/** The data of a token, or the union over a union of tokens. */
export type EventData<T> = T extends EventToken<infer D extends JsonValue> ? D : never

export function defineEvent<D extends JsonValue>(
  name: string,
  options: { version?: number; fails?: string } = {},
): EventToken<D> {
  const kind = `event.${name}`
  return {
    name,
    kind,
    version: options.version ?? 1,
    ...(options.fails ? { fails: options.fails } : {}),
    is: (event): event is EventRecord<D> => event?.kind === kind,
  }
}

/** A notice an extension showed (`host.notice`), recorded once per distinct message and facet load. */
export const NoticeEvent = defineEvent<{ extension: string; message: string; level: string }>(
  'ultimate.notice',
)

/** This process opened storage and serves: its supervisor generation and the build it runs. */
export const StartedEvent = defineEvent<{ generation: number; build: string }>('ultimate.started')

/**
 * The browser a user request came from, `desktop chrome` or `phone safari`, and its Tailscale login and tailnet
 * `address` (`100.64.0.0/10` or `fd7a:115c:a1e0::/48`) when it came through Tailscale Serve. Nothing else of the
 * request is kept.
 */
export type Device = { device: string; login?: string; address?: string }

/**
 * The user gave conversation `conversation` an input: typed (`prompt`, or `steer`/`follow-up` while it ran), an answer
 * or dismissal of its question (`message`, the reply), or a review. `entry` is its transcript entry once placed;
 * a queued one names its `submission`, whose record gets the entry. Never the text: `length` counts its characters.
 */
export const UserInputEvent = defineEvent<
  {
    conversation: number
    kind: 'prompt' | 'steer' | 'follow-up' | 'answer' | 'dismiss' | 'review'
    entry?: number
    submission?: number
    message?: number
    length: number
  } & Partial<Device>
>('user.input')

/** The user switched the surface on screen (`agent`, `system`, …) or the conversation open on it. */
export const NavigatedEvent = defineEvent<
  { surface: string; conversation?: number } & Partial<Device>
>('ui.navigated')

/** The events core defines here; extensions declare theirs in their refs.ts, listed in `ExtensionInfo.events`. */
export const CORE_EVENTS = [NoticeEvent, StartedEvent, UserInputEvent, NavigatedEvent].map(
  (event) => event.name,
)

/** Root document with the newest events, which `useEvents()` streams to the browser. */
export const EVENT_FEED = 'ultimate.event-feed'
export const EVENT_FEED_SIZE = 100
