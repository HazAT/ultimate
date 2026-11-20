import { useEffect, useSyncExternalStore } from 'react'
import { api, useSystem } from '@/sdk'
import { familiesCache, refresh, refreshFor } from './family-state.ts'
import { FamiliesAction } from './refs.ts'

const fetchFamilies = () => api.action(FamiliesAction, null)
export const refreshFamilies = () => refresh(fetchFamilies)

export function useFamilies() {
  const current = useSyncExternalStore(familiesCache.subscribe, familiesCache.get)
  const system = useSystem()
  const revision = `${system?.code.sha} ${JSON.stringify(system?.project.settings)}`
  useEffect(() => {
    void refreshFor(revision, fetchFamilies)
  }, [revision])
  useEffect(() => {
    const reload = () => void refreshFamilies()
    globalThis.addEventListener?.('focus', reload)
    return () => globalThis.removeEventListener?.('focus', reload)
  }, [])
  return current
}
