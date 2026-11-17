import { defineEntry } from '@earendil-works/pi-durable'
import type { ReviewComments } from './types.ts'

export const ReviewCommentsEntry = defineEntry<ReviewComments>('review.comments')
