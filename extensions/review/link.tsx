import { useSyncExternalStore } from 'react'
import { useExtensionUiState } from '@/sdk'
import { defaultSpec, getTarget, setTarget, specKey, subscribeTarget } from './link-state.ts'

export type { ReviewTarget } from './link-state.ts'

export const useSpec = () => useExtensionUiState(specKey, defaultSpec)
export const useTarget = () => useSyncExternalStore(subscribeTarget, getTarget)
export const reachedTarget = () => setTarget()
