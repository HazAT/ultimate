/** UI changes in the browser: the change log of ui-sdk components, who made each change and where. Browser-safe. */
import type { ConversationId } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord/json'
import { actionRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'
import type { Device } from '../../shared/events.ts'

/** One change to a ui-sdk component, as the page's agent bridge observed it. */
export type UiChange = {
  /** The component, like `switch`. */
  component: string
  /** Its accessible name. */
  label?: string
  /** What changed, like `checked` or `value`. */
  key: string
  /** The new value; `"[redacted]"` inside `data-agent-secret`, `"[too large]"` past the size limit. */
  value: JsonValue
  previous?: JsonValue
  /** Who changed it: `agent`, or how a person did (`mouse`, `keyboard`, `touch`, `pen`, `virtual`, `programmatic`). */
  source: string
  /** Why, like `item-press`. */
  reason?: string
}

/**
 * `ui.changed`: one change to a ui-sdk component, with the surface and conversation the page showed, `driven` when an
 * agent drove that page (the browser tool), and the device of the browser that reported it.
 */
export const ChangedEvent = defineEvent<
  UiChange & { surface?: string; conversation?: ConversationId; driven?: true } & Partial<Device>
>('ui.changed')

/**
 * `{ changes, surface?, conversation?, driven? }` → `{ recorded }`: the page reports a batch of component changes, and
 * each becomes one `ui.changed` event, all in one commit. At most 50 changes; `value` is required (`null` for none);
 * a `value` or `previous` over 2048 UTF-8 bytes of JSON becomes `"[too large]"`. Limits: `limits.ts`.
 */
export const RecordAction = actionRef<
  { changes: UiChange[]; surface?: string; conversation?: ConversationId; driven?: boolean },
  { recorded: number }
>('ui', 'record')
