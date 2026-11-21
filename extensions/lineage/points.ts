import type { JSX } from '@solidjs/web'
import { definePoint } from '../../web/src/sdk/types.ts'

export const MemoryHeader = definePoint<object, JSX.Element>('lineage.memory-header')
