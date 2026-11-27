import { defineEntry } from '@earendil-works/pi-durable'
import type { LanderEntry } from './types.ts'

export const LanderLog = defineEntry<LanderEntry>('ultimate.lander')
