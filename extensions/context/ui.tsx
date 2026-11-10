/** Context for other extensions' browser code: the point where they add to a cache-rebuilt line. */
import { definePoint } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import type { CacheBust } from '../../lib/context-usage.ts'

/**
 * More about the rebuild `entry` paid for, such as what it cost: each provider's `text` shows as one more `· …` part
 * at the end of its cache-rebuilt line, never cut off, with `title` as its tooltip; undefined adds nothing.
 */
export const CacheRebuiltDetail = definePoint<
  { entry: EntryRecord; bust: CacheBust },
  { text: string; title?: string } | undefined
>('context.cache-rebuilt')
