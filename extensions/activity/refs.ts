/** Activity in the browser: a page of the durable event log, older than the live feed holds. Browser-safe. */
import type { EntryId } from '@earendil-works/pi-durable'
import { actionRef } from '../../shared/extension-api.ts'
import type { EventRecord } from '../../shared/events.ts'

/**
 * `{ kinds, before?, since?, limit? }` → `{ events, next? }`: at most `limit` (default 50, at most 200) events of the
 * named kinds (`workspaces.landed`), newest first, older than event id `before` and no older than `since` (ISO).
 * `next` pages back from the last one; it is absent once nothing older matches.
 */
export const PageAction = actionRef<
  { kinds: string[]; before?: EntryId; since?: string; limit?: number },
  { events: EventRecord[]; next?: EntryId }
>('activity', 'page')
