/** Push: Web Push notifications to the user's subscribed browsers, for other extensions to send and close. */
import { defineApi } from '../../shared/extension-api.ts'
import type { Push } from './rules.ts'

export type { Push } from './rules.ts'

export type PushService = {
  /**
   * Push `push` to every subscribed browser not showing the app (seen on screen in the last 15 s). A newer push with
   * the same `tag` replaces the shown one. Never throws: failures become notices.
   */
  notify(push: Push): void
  /** Close the notification tagged `tag` on every device with the app open, as an answered question's closes. */
  close(tag: string): void
}
/** Notifications for other extensions; `want` it, push is optional and off by default. */
export const PushApi = defineApi<PushService>()('push')
