/** Models for other extensions' React code: family labels and editors, explicit picks, and login changes. */
import { useSyncExternalStore } from 'react'
import { picks } from './state.ts'
export { dialogs as modelDialogs } from './state.ts'
export { AddFamily, FamilyPopover, moveFeature } from './family-editor.tsx'
export {
  agentsPanel,
  FamilyDot,
  FamilyLabel,
  refreshFamilies,
  runsOn,
  useFamilies,
} from './families.tsx'
export type { FamiliesView, FamilyView } from './refs.ts'
export { LoginChanged, SetDefaultAction } from './refs.ts'
export const usePicks = () => useSyncExternalStore(picks.subscribe, picks.get)
