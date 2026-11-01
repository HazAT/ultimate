/** The tints an agent definition's `tint` may name; the web side maps each to theme-aware classes (conversations' marks). */
export const markTints = [
  'violet',
  'blue',
  'green',
  'amber',
  'red',
  'pink',
  'teal',
  'grey',
] as const
export type MarkTint = (typeof markTints)[number]
export const isMarkTint = (value: unknown): value is MarkTint =>
  typeof value === 'string' && (markTints as readonly string[]).includes(value)

/** A lucide icon name as a definition's `icon` writes it: PascalCase (`NotebookPen`) or kebab-case (`notebook-pen`). */
export const isIconName = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]*(-[a-z0-9]+)*$/.test(value)
