import type { ComponentType } from 'react'
import { definePoint } from '../../web/src/sdk/types.ts'

export const SYSTEM_TAB_KEY = 'ext.system.tab'
export const SystemTab = definePoint<
  null,
  { id: string; title: string; component: ComponentType } | undefined
>('system.tab')
