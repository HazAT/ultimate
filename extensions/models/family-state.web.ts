import { cell } from '../../lib/cell.web.ts'
import { DEFAULT_FAMILY } from '../../lib/families.shared.ts'
import type { FamiliesView, FamilyView } from './refs.ts'

export const agentsPanel = 'agents'
export const familiesCache = cell<FamiliesView | undefined>(undefined)

let revision: string | undefined
let loading: Promise<void> | undefined

export function refresh(fetch: () => Promise<FamiliesView>) {
  loading ??= fetch()
    .then(familiesCache.set)
    .catch((error: unknown) => console.error('models: families not loaded', error))
    .finally(() => {
      loading = undefined
    })
  return loading
}

export function refreshFor(next: string, fetch: () => Promise<FamiliesView>) {
  if (revision === next) return undefined
  revision = next
  return refresh(fetch)
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
