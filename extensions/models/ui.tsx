/**
 * Models for other extensions' browser code: one model as the picker lists it, the families with their labels and
 * in-place editors, and the login-changed event.
 */
export { ModelRow } from './picker.tsx'
/**
 * More rows for the model picker (`acp` lists its external agents), each a `CommandItem` inside a `CommandGroup`. The
 * input carries the search `query`, the conversation the picker acts on, and `close` to call once a row is chosen.
 */
export { PickerRows } from './points.tsx'
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
/** Open the model picker for the shown conversation (or `conversationId`), as the composer's model button does. */
export { openPicker, usePicks } from './state.tsx'
