/** Typed transcript entries written by this extension. Browser-safe. */
import { defineEntry } from '@earendil-works/pi-durable'
import type { Fallback } from './refs.ts'

/** A provider-login fallback or a request for the user to pick a model. */
export const FallbackEntry = defineEntry<Fallback>('models.fallback')
