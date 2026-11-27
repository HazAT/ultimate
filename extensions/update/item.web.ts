import type { UpdateState } from './refs.ts'

export function itemOf(state: UpdateState): 'none' | 'current' | 'behind' | 'install' | 'restart' {
  if (state.preview) return 'none'
  if (state.behind) return 'behind'
  if (state.install) return 'install'
  const updated = state.updated
  const cloneNeedsRestart =
    state.restart ||
    (updated && (updated.layers.core || updated.layers.lockfile || updated.layers.bin))
  if (cloneNeedsRestart) return 'restart'
  return 'current'
}
