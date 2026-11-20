import { defineEntry } from '@earendil-works/pi-durable'
import type { CarriedEntry, ChapterEntry } from './refs.ts'

export const ChapterStarted = defineEntry<ChapterEntry>('dream.chapter')

export const ChapterPrepared = defineEntry<{ at: number }>('dream.prepared')

export const BranchCarried = defineEntry<CarriedEntry>('dream.carried')
