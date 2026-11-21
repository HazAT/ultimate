/** Browser recordings: look up playable clips and their source conversations. */
import type { Context } from '@earendil-works/chord/context'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { BrowserClip } from '../../lib/browser-video.ts'
import { defineApi } from '../../shared/extension-api.ts'

type BrowserRecordingsService = {
  /** Find the committed clip and its owner, only when its private WebM is readable. */
  find(
    id: string,
    ctx: Context,
  ): Promise<(BrowserClip & { conversation: ConversationId }) | undefined>
}

/** Lookup for private clips served by the browser extension with file key `video`. */
export const BrowserRecordings = defineApi<BrowserRecordingsService>()('browser')
