import { existsSync, watch } from 'node:fs'
import { dirname } from 'node:path'
import { isMissing } from '../lib/errors.ts'

/** Watch missing roots through their nearest existing parent, without scanning siblings. */
export function watchRoots(roots: string[], appeared: (root: string) => void) {
  const cleanups = roots.map((root) => {
    let closed = false
    let present = existsSync(root)
    let watcher: ReturnType<typeof watch>
    let watchedAncestor: string | undefined
    const attach = () => {
      let ancestor = dirname(root)
      while (!existsSync(ancestor)) ancestor = dirname(ancestor)
      // Sibling activity must not churn watchers, especially when the ancestor is /tmp.
      if (ancestor !== watchedAncestor) {
        watcher?.close()
        for (;;) {
          try {
            watcher = watch(ancestor, () => {
              if (!closed) attach()
            })
            watchedAncestor = ancestor
            break
          } catch (error) {
            if (!isMissing(error)) throw error
            ancestor = dirname(ancestor)
          }
        }
      }
      const next = existsSync(root)
      if (next && !present) appeared(root)
      present = next
    }
    attach()
    return () => {
      closed = true
      watcher.close()
    }
  })
  return () => cleanups.forEach((close) => close())
}
