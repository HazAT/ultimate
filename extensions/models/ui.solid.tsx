/** Model family readers and editors, and model catalog controls for Solid surfaces. */
export { FamilyLabel, refreshFamilies, usePicks } from './families.solid.tsx'
export { AddFamily, FamilyPopover, moveFeature } from './family-editor.solid.tsx'
export { agentsPanel, modelIdOf, runsOn } from './family-state.web.ts'
export { ModelRow } from './model-row.solid.tsx'
export { ModelSelect } from './model-select.solid.tsx'
export { FamilyDot, useFamilies } from './readers.solid.tsx'
/** The composer's model and thinking chip over a pick kept outside any conversation (`ModelPick`). */
export { PickControl } from './toolbar.solid.tsx'
/**
 * A model and thinking pick kept outside any conversation, such as the model the next voice session starts on: the chip
 * and the picker read `ref` and `thinking` and write through `configure` instead of a conversation's agent. `name` is
 * unique among picks and names the chip (`<name> model`) and its thinking dialog.
 */
export type { ModelPick } from './state.web.ts'
/** The provider login and model picker dialog IDs, for Get ready's focus handoff. */
export { dialogs as modelDialogs } from './state.web.ts'
/** Groups of extra choices in the picker, with an optional adjacent secondary action. */
export { PickerRows } from './points.web.ts'
