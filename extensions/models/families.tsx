import { useEffect, useSyncExternalStore } from 'react'
import { api, cn, useSystem } from '@/sdk'
import { DEFAULT_FAMILY, familyColor, familyTitle } from '../../lib/families.ts'
import { FamiliesAction } from './refs.ts'
import type { FamiliesView, FamilyView } from './refs.ts'

export const agentsPanel = 'agents'

let sharedFamiliesView: FamiliesView | undefined
let fetchedSettingsAndCommitRevision: string | undefined
let loading: Promise<void> | undefined
const listeners = new Set<() => void>()

export function refreshFamilies() {
  loading ??= api
    .action(FamiliesAction, null)
    .then((next) => {
      sharedFamiliesView = next
      for (const listener of listeners) listener()
    })
    .catch((error: unknown) => console.error('models: families not loaded', error))
    .finally(() => {
      loading = undefined
    })
  return loading
}

export function useFamilies() {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => sharedFamiliesView,
  )
  const system = useSystem()
  const settingsAndCommitRevision = `${system?.code.sha} ${JSON.stringify(system?.project.settings)}`
  useEffect(() => {
    if (fetchedSettingsAndCommitRevision === settingsAndCommitRevision) return
    fetchedSettingsAndCommitRevision = settingsAndCommitRevision
    void refreshFamilies()
  }, [settingsAndCommitRevision])
  useEffect(() => {
    const refresh = () => void refreshFamilies()
    globalThis.addEventListener?.('focus', refresh)
    return () => globalThis.removeEventListener?.('focus', refresh)
  }, [])
  return current
}

export const runsOn = (family: FamilyView) => family.model ?? family.follows

export const thinkingOf = (family: FamilyView) =>
  family.thinking ?? (family.model ? undefined : family.followsThinking)

export function familyOf(
  families: FamiliesView | undefined,
  ref: { provider: string; modelId: string } | undefined,
  thinking: string | undefined,
  recorded: string | null | undefined,
) {
  if (!ref) return undefined
  const family = families?.families.find((item) => item.name === (recorded ?? DEFAULT_FAMILY))
  if (!family || recorded) return family
  const stillUsesDefault =
    runsOn(family) === `${ref.provider}/${ref.modelId}` &&
    (thinkingOf(family) ?? thinking) === thinking
  return stillUsesDefault ? family : undefined
}

export const modelIdOf = (ref: string) => ref.slice(ref.indexOf('/') + 1)

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
