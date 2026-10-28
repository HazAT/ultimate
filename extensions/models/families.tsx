/**
 * Model families in the browser: one shared copy of the families (fetched once, again on window focus and after a
 * save), the family a model belongs to, and the "Family (model)" label every model shows with.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { api, cn } from '@/sdk'
import { DEFAULT_FAMILY, familyColor, familyTitle } from '../../lib/families.ts'
import { FamiliesAction } from './refs.ts'
import type { FamiliesView, FamilyView } from './refs.ts'

export const familiesDialog = 'models.families'

let view: FamiliesView | undefined
let loading: Promise<void> | undefined
const listeners = new Set<() => void>()

/** Fetch the families again; every `useFamilies` updates. */
export function refreshFamilies() {
  loading ??= api
    .action(FamiliesAction, null)
    .then((next) => {
      view = next
      for (const listener of listeners) listener()
    })
    // The labels fall back to plain model names; the next focus or save asks again.
    .catch((error: unknown) => console.error('models: families not loaded', error))
    .finally(() => {
      loading = undefined
    })
  return loading
}

/** The families, shared by every component; undefined until the first fetch answers. */
export function useFamilies() {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => view,
  )
  useEffect(() => {
    // oxlint-disable-next-line typescript/no-floating-promises -- refreshFamilies catches its failure; the next focus asks again.
    if (!view) void refreshFamilies()
    // oxlint-disable-next-line typescript/no-floating-promises -- as above.
    const refresh = () => void refreshFamilies()
    // A test renders without a window.
    globalThis.addEventListener?.('focus', refresh)
    return () => globalThis.removeEventListener?.('focus', refresh)
  }, [])
  return current
}

type Ref = { provider: string; modelId: string }

/**
 * The family `ref` runs as: `hint` (a conversation's or definition's own family) when its model is `ref`, else the
 * family of that model with the same thinking level, else the first family of that model, the default one first.
 */
export function familyOf(
  families: FamiliesView | undefined,
  ref: Ref | string | undefined,
  thinking?: string,
  hint?: string,
): FamilyView | undefined {
  if (!families || !ref) return undefined
  const name = typeof ref === 'string' ? ref : `${ref.provider}/${ref.modelId}`
  const matching = families.families.filter((family) => runsOn(family) === name)
  return (
    matching.find((family) => family.name === hint) ??
    (thinking ? matching.find((family) => family.thinking === thinking) : undefined) ??
    matching[0]
  )
}

/** The model a family runs: its own, or Pi's default for a default family without one. */
export const runsOn = (family: FamilyView) => family.model ?? family.follows

const modelIdOf = (ref: Ref | string) =>
  typeof ref === 'string' ? ref.slice(ref.indexOf('/') + 1) : ref.modelId

/** "Fast (gpt-6-luna)", or the model id alone when no family runs it. */
export function modelLabel(
  families: FamiliesView | undefined,
  ref: Ref | string,
  thinking?: string,
  hint?: string,
) {
  const family = familyOf(families, ref, thinking, hint)
  return family ? `${familyTitle(family.name)} (${modelIdOf(ref)})` : modelIdOf(ref)
}

/** A family's color dot. */
export function FamilyDot({ color, className }: { color: string | undefined; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2 shrink-0 rounded-full', className)}
      style={{ backgroundColor: familyColor(color) }}
    />
  )
}

/** A family by name: its dot and title. */
export function FamilyName({ family, className }: { family: FamilyView; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <FamilyDot color={family.color} />
      <span className="truncate">{familyTitle(family.name)}</span>
    </span>
  )
}

/**
 * A model as "● Family (model)", the family's color on the dot and its name, or the bare model id when no family runs
 * it. `fallback` shows instead while there is no model.
 */
export function ModelLabel({
  model,
  thinking,
  family: hint,
  fallback = 'no model',
  className,
}: {
  model: Ref | string | undefined
  thinking?: string
  family?: string
  fallback?: string
  className?: string
}) {
  const families = useFamilies()
  if (!model) return <span className={className}>{fallback}</span>
  const family = familyOf(families, model, thinking, hint)
  if (!family) return <span className={cn('truncate', className)}>{modelIdOf(model)}</span>
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <FamilyDot color={family.color} />
      <span className="truncate">
        <span style={{ color: familyColor(family.color) }}>{familyTitle(family.name)}</span>
        <span className="text-muted-foreground"> ({modelIdOf(model)})</span>
      </span>
    </span>
  )
}

/** A family by name, for a definition or feature that runs on it: "● Fast (gpt-6-luna)". */
export function FamilyLabel({
  family: name,
  className,
}: {
  family: string | undefined
  className?: string
}) {
  const families = useFamilies()
  const family = families?.families.find((item) => item.name === (name ?? DEFAULT_FAMILY))
  if (!family) return <span className={className}>{name ? familyTitle(name) : 'Default'}</span>
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
