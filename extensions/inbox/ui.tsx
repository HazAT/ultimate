/** Inbox's React points: items that wait on the user and an optional takeover of the reading pane. */

/** All providers' items, merged in the Inbox and its counters in waiting order. */
export { InboxItems } from './points.ts'
/** A pane to show instead of the focused question, or undefined to keep the Inbox's own pane. */
export { QuestionPane } from './points.ts'
/** A waiting item, whose unique key selects it from `?inbox=<key>` or `inbox:open { key }`. */
export type { InboxItem } from './points.ts'
