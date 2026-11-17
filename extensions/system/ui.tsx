/** System's points for other extensions' browser code: a tab of their own on the System surface. */
import type { ComponentType } from 'react'
import { definePoint } from '@/sdk'

/**
 * A tab beside Agents on the System surface (`wire` provides one). Several extensions may provide it; tabs show in
 * discovery order. `id` is kept in the URL-free UI state `ext.system.tab`, so `openTab` from anywhere switches to it.
 * The component fills the surface below System's header, its own header line included.
 */
export const SystemTab = definePoint<
  null,
  { id: string; title: string; component: ComponentType } | undefined
>('system.tab')

/** The UI state key of System's open tab; set it to a provided tab's `id` before `showSurface('system')`. */
export const SYSTEM_TAB_KEY = 'ext.system.tab'
