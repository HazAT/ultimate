/**
 * Pause: whether the user paused this Ultimate, for timers that start work outside the task scheduler, and an
 * extension's hold on the host with its reason.
 */
import { defineApi } from '../../shared/extension-api.ts'
import type { Hold, PauseState } from './refs.ts'

export type PauseService = {
  /** Whether the host is paused; a timer that starts work (a fetch, a ping, a backup) skips its tick while it is. */
  paused(): boolean
  /**
   * Pause the host with a reason, `{ source, reason }`: the pause the user presses, with the extension named and one
   * short line saying why, which the status line and its popover show. Play continues as usual. A hold on a host that
   * is already paused joins that pause without restarting it. Resolves with the pause.
   */
  hold(hold: Hold): Promise<PauseState>
}
/** The pause; `want` it, pause is optional. */
export const PauseApi = defineApi<PauseService>()('pause')
