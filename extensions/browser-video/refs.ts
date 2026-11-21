/** Browser recordings available to play on a landing card. */
import type { ConversationId } from '@earendil-works/pi-durable'
import { actionRef } from '../../shared/extension-api.ts'
import type { QuestionClip } from '../messages/refs.ts'

/** `{ conversation }` → a branch's recent available clips, most recent first. No media bytes. */
export const LandingClipsAction = actionRef<{ conversation: ConversationId }, QuestionClip[]>(
  'browser-video',
  'landingClips',
)
