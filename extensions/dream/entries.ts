/** Typed transcript entries written by this extension. Browser-safe. */
import { defineEntry } from '@earendil-works/pi-durable'
import type { ChapterEntry } from './refs.ts'

/** A chapter's wake-up card. */
export const ChapterStarted = defineEntry<ChapterEntry>('dream.chapter')

/** The preparation announced by @ultimate. */
export const ChapterPrepared = defineEntry<{ at: number }>('dream.prepared')
