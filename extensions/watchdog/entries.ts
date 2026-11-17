import { defineEntry } from '@earendil-works/pi-durable'
import type { Failure } from './refs.ts'

export const FailureEntry = defineEntry<Failure>('watchdog.failure')

export const IdleEntry = defineEntry<{ text: string }>('watchdog.idle')
