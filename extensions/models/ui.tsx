/** Models for other extensions' React code: family settings, explicit picks, and login changes. */
import { useSyncExternalStore } from 'react'
import { picks } from './state.ts'
export { dialogs as modelDialogs } from './state.ts'
export { refreshFamilies, useFamilies } from './families.tsx'
export { agentsPanel, runsOn } from './family-state.ts'
export type { FamiliesView, FamilyView } from './refs.ts'
export { LoginChanged, SetDefaultAction } from './refs.ts'
export const usePicks = () => useSyncExternalStore(picks.subscribe, picks.get)
