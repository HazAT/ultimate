import type { ConversationId, EntryId, TaskId } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord/json'

export type EventContext = {
  traceId?: string
  conversationId?: ConversationId
  taskId?: TaskId
  entryId?: EntryId
  parentCall?: string
}

type EventDataShapeVersion = number
type EventNameWhoseWaitFails = string
export type EventRecord<D extends JsonValue = JsonValue> = {
  id: EntryId
  name: string
  kind: string
  v: EventDataShapeVersion
  at: string
  data: D
  context?: EventContext
  fails?: EventNameWhoseWaitFails
}

export interface EventToken<D extends JsonValue = JsonValue> {
  readonly name: string
  readonly kind: string
  readonly version: number
  readonly fails?: EventNameWhoseWaitFails
  is(event: EventRecord | undefined): event is EventRecord<D>
}

export type EventData<T> = T extends EventToken<infer D extends JsonValue> ? D : never

export function defineEvent<D extends JsonValue>(
  name: string,
  options: { version?: number; fails?: EventNameWhoseWaitFails } = {},
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

export const NoticeEvent = defineEvent<{ extension: string; message: string; level: string }>(
  'ultimate.notice',
)

export const StartedEvent = defineEvent<{ generation: number; build: string }>('ultimate.started')

export type Device = { device: string; login?: string; address?: string }

type InputCharacterCount = number
export const UserInputEvent = defineEvent<
  {
    conversation: ConversationId
    kind: 'prompt' | 'steer' | 'follow-up' | 'answer' | 'dismiss' | 'review'
    entry?: EntryId
    submission?: number
    message?: number
    length: InputCharacterCount
  } & Partial<Device>
>('user.input')

export const NavigatedEvent = defineEvent<
  { surface: string; conversation?: ConversationId } & Partial<Device>
>('ui.navigated')

export const CORE_EVENTS = [NoticeEvent, StartedEvent, UserInputEvent, NavigatedEvent].map(
  (event) => event.name,
)

export const EVENT_FEED = 'ultimate.event-feed'
export const EVENT_FEED_SIZE = 100
