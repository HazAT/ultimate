/**
 * Model families in the browser: one shared copy of the families (fetched once, again on window focus, after a save
 * and when the system info shows new project settings or a new commit), and a family's dot and "Family (model)" label
 * for the Agents panel and the definition form.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { api, cn, useSystem } from '@/sdk'
import { DEFAULT_FAMILY, familyColor, familyTitle } from '../../lib/families.ts'
import { FamiliesAction } from './refs.ts'
import type { FamiliesView, FamilyView } from './refs.ts'

/** The Agents panel (subagents' own), where the families are edited beside who runs on each. */
export const agentsPanel = 'agents'

let view: FamiliesView | undefined
/** The project settings and commit `view` was last fetched for. */
let fetchedFor: string | undefined
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
    // The panel waits for them; the next focus or save asks again.
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
  const system = useSystem()
  // The settings file and landings both reach the open tab as a system broadcast.
  const source = `${system?.code.sha} ${JSON.stringify(system?.project.settings)}`
  useEffect(() => {
    if (fetchedFor === source) return
    fetchedFor = source
    // oxlint-disable-next-line typescript/no-floating-promises -- refreshFamilies catches its failure; the next focus asks again.
    void refreshFamilies()
  }, [source])
  useEffect(() => {
    // oxlint-disable-next-line typescript/no-floating-promises -- as above.
    const refresh = () => void refreshFamilies()
    // A test renders without a window.
    globalThis.addEventListener?.('focus', refresh)
    return () => globalThis.removeEventListener?.('focus', refresh)
  }, [])
  return current
}

/** The model a family runs: its own, or Pi's default for a default family without one. */
export const runsOn = (family: FamilyView) => family.model ?? family.follows

/** The thinking level a family runs at: its own, or Pi's default one for a default family that follows Pi's model. */
export const thinkingOf = (family: FamilyView) =>
  family.thinking ?? (family.model ? undefined : family.followsThinking)

/**
 * The family a conversation runs as: the one recorded for it (`FamilyDoc`), whatever model it runs (a preview runs
 * every family on one). Without a record nothing named a family, so it is the default family while it runs that
 * family's model and thinking level. Never worked out from the model alone: two families can share one.
 */
export function familyOf(
  families: FamiliesView | undefined,
  ref: { provider: string; modelId: string } | undefined,
  thinking: string | undefined,
  recorded: string | null | undefined,
) {
  if (!ref) return undefined
  const family = families?.families.find((item) => item.name === (recorded ?? DEFAULT_FAMILY))
  if (!family || recorded) return family
  return runsOn(family) === `${ref.provider}/${ref.modelId}` &&
    (thinkingOf(family) ?? thinking) === thinking
    ? family
    : undefined
}

export const modelIdOf = (ref: string) => ref.slice(ref.indexOf('/') + 1)

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
