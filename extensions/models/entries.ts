import { defineEntry } from '@earendil-works/pi-durable'
import type { Fallback } from './refs.ts'

export const FallbackEntry = defineEntry<Fallback>('models.fallback')
