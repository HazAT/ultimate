/** Browser recordings available to play on a landing card. */
import type { ConversationId } from '@earendil-works/pi-durable'
import { actionRef } from '../../shared/extension-api.ts'
import type { QuestionClip } from '../messages/refs.ts'

/** `{ conversation }` → available selected question clips, then recent branch recordings. No media bytes. */
export const LandingClipsAction = actionRef<{ conversation: ConversationId }, QuestionClip[]>(
  'browser-video',
  'landingClips',
)
