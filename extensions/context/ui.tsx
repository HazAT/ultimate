/** Context for other extensions' browser code: the point where they redraw a cache-rebuilt line. */
import type { ReactNode } from 'react'
import { definePoint } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import type { CacheBust } from '../../lib/context-usage.ts'

/**
 * The line above a response that rebuilt the prompt cache, rendered through `<Rendered>`: a provider gets the
 * response's `entry`, its `bust` and the line so far as `core`, and returns it, wraps it or draws its own.
 */
export const CacheRebuiltLine = definePoint<
  { entry: EntryRecord; bust: CacheBust; core: ReactNode },
  ReactNode
>('context.cache-rebuilt')
