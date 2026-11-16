import { createContext, useContext, useSyncExternalStore } from 'react'
import { layout } from '../sdk/actions.ts'
import { HOME } from '../sdk/registry.ts'

export const SurfaceContext = createContext<string>(HOME)
export const useSurfaceId = () => useContext(SurfaceContext)

export function useRegion(region: 'sidebar' | 'panels') {
  return useSyncExternalStore(layout.subscribe, () => layout.has(region))
}
