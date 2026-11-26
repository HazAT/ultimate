import { existsSync, watch } from 'node:fs'
import { dirname } from 'node:path'
import { isMissing } from '../lib/errors.ts'
import { closeOnWatchError } from '../lib/watch.ts'

export function watchRoots(roots: string[], appeared: (root: string) => void) {
  const cleanups = roots.map((root) => {
    let closed = false
    let present = existsSync(root)
    let watcher: ReturnType<typeof watch>
    let watchedAncestor: string | undefined
    const attach = () => {
      let ancestor = dirname(root)
      while (!existsSync(ancestor)) ancestor = dirname(ancestor)
      const nearestExistingAncestorChanged = ancestor !== watchedAncestor
      if (nearestExistingAncestorChanged) {
        watcher?.close()
        for (;;) {
          try {
            const directory = ancestor
            const current = watch(directory, () => {
              if (!closed) attach()
            })
            watcher = closeOnWatchError(current, directory)
            watchedAncestor = directory
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
