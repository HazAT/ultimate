import { defineEntry } from '@earendil-works/pi-durable'
import type { LanderEntry } from './types.ts'

/** One line of the lander's display-only log. */
export const LanderLog = defineEntry<LanderEntry>('ultimate.lander')
