import type { Component } from 'solid-js'
import { definePoint } from '../../web/src/sdk/types.ts'

export const SYSTEM_TAB_KEY = 'ext.system.tab'
export const SystemTab = definePoint<
  null,
  { id: string; title: string; component: Component } | undefined
>('system.tab')
