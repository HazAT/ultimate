import type { ConversationId } from '@earendil-works/pi-durable'
import type { ReviewComment } from './comments.ts'

export type Draft = Omit<ReviewComment, 'excerpt'> & { id: string }

export type Drafts = { comments: Draft[]; note: string; to?: ConversationId }
