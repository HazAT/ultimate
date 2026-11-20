import type { ConversationId } from '@earendil-works/pi-durable'
import type { ReactNode } from 'react'
import { definePoint } from '@/sdk/types.ts'

export const Review = definePoint<string, (() => void) | undefined>('workspaces.review')

export const LandedNote = definePoint<
  { conversation: ConversationId; submission: string },
  ReactNode
>('workspaces.landed-note')

export const LandingExtras = definePoint<{ conversation: ConversationId }, ReactNode>(
  'workspaces.landing-extras',
)
