import { defineEntry } from '@earendil-works/pi-durable'
import type { ReviewComments } from './types.ts'

/** Review comments submitted as a conversation input. */
export const ReviewCommentsEntry = defineEntry<ReviewComments>('review.comments')
