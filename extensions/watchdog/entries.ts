import { defineEntry } from '@earendil-works/pi-durable'
import type { Failure } from './refs.ts'

/** A run failure delivered to @ultimate. */
export const FailureEntry = defineEntry<Failure>('watchdog.failure')

/** A quiet idle continuation. */
export const IdleEntry = defineEntry<{ text: string }>('watchdog.idle')
