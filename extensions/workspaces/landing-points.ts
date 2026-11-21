import type { ConversationId } from '@earendil-works/pi-durable'
import type { JSX } from '@solidjs/web'
import { definePoint } from '@/sdk/types.ts'

export const Review = definePoint<string, (() => void) | undefined>('workspaces.review')

export const LandedNote = definePoint<
  { conversation: ConversationId; submission: string },
  JSX.Element
>('workspaces.landed-note')

export const LandingExtras = definePoint<{ conversation: ConversationId }, JSX.Element>(
  'workspaces.landing-extras',
)
