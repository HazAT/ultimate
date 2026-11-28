export type FoldLine =
  | { kind: 'row'; id: number; depth: number; fold?: { count: number; open: boolean } }
  | { kind: 'earlier'; parent: number; count: number; open: boolean }

const KEEP = 2

export const earlierKey = (parent: number) => `earlier:${parent}`

export function foldLines(
  root: number,
  children: (id: number) => readonly number[] | undefined,
  quiet: (id: number) => boolean,
  opened: ReadonlySet<string>,
): FoldLine[] {
  const still = new Map<number, boolean>()
  const isStill = (id: number): boolean => {
    let known = still.get(id)
    if (known === undefined) {
      known = quiet(id) && (children(id) ?? []).every(isStill)
      still.set(id, known)
    }
    return known
  }
  const size = (id: number): number =>
    (children(id) ?? []).reduce((sum, child) => sum + 1 + size(child), 0)
  const lines: FoldLine[] = []
  const walk = (id: number, depth: number) => {
    const ids = children(id) ?? []
    const older = depth === 0 ? ids.filter(isStill).slice(0, -KEEP) : []
    const folded = older.length > 1 && !opened.has(earlierKey(id))
    for (const child of ids) {
      if (older.length > 1 && child === older[0])
        lines.push({ kind: 'earlier', parent: id, count: older.length, open: !folded })
      if (folded && older.includes(child)) continue
      const count = size(child)
      const fold =
        count > 0 && isStill(child) ? { count, open: opened.has(String(child)) } : undefined
      lines.push({ kind: 'row', id: child, depth, fold })
      if (!fold || fold.open) walk(child, depth + 1)
    }
  }
  walk(root, 0)
  return lines
}
