import { useEffect, useSyncExternalStore } from 'react'
import { api, cn, useSystem } from '@/sdk'
import { DEFAULT_FAMILY, familyColor, familyTitle } from '../../lib/families.ts'
import { familiesCache, modelIdOf, refresh, refreshFor, runsOn } from './family-state.ts'
import { FamiliesAction } from './refs.ts'

export { agentsPanel, runsOn } from './family-state.ts'

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

export function FamilyDot({ color, className }: { color: string | undefined; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2 shrink-0 rounded-full', className)}
      style={{ backgroundColor: familyColor(color) }}
    />
  )
}

export function FamilyLabel({
  family: name,
  className,
}: {
  family: string | undefined
  className?: string
}) {
  const families = useFamilies()
  const family = families?.families.find((item) => item.name === (name ?? DEFAULT_FAMILY))
  if (!family) return <span className={className}>{familyTitle(name ?? DEFAULT_FAMILY)}</span>
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <FamilyDot color={family.color} />
      <span className="truncate">
        <span style={{ color: familyColor(family.color) }}>{familyTitle(family.name)}</span>
        {runsOn(family) && (
          <span className="text-muted-foreground"> ({modelIdOf(runsOn(family)!)})</span>
        )}
      </span>
    </span>
  )
}
