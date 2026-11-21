import { useMemo } from 'react'
import type { ComponentType } from 'react'
import { shellKeys } from '../sdk/actions.ts'
import { documentItems, panelItems, shownPanels } from '../sdk/registry.ts'
import { useExtensions, useRegionOpen, useUiState } from './hooks.ts'
import { isReact } from '../sdk/framework.ts'
import { island } from './island.tsx'

const wrapped = new WeakMap<object, ComponentType<never>>()

/** A contribution as a React component: a React one as it is, a Solid one wrapped once in an island. */
function asReact(component: unknown): ComponentType<never> {
  if (isReact(component)) return component as ComponentType<never>
  let react = wrapped.get(component as object)
  if (!react) {
    react = island(component as never) as ComponentType<never>
    wrapped.set(component as object, react)
  }
  return react
}

/**
 * The right panel's state: whether it is open, the panel it shows (the chosen one, else the first with a tab) and the
 * panels in its tab row.
 */
export function usePanels() {
  const records = useExtensions()
  const panels = useMemo(
    () =>
      panelItems(records).map((panel) => ({
        ...panel,
        icon: panel.icon && asReact(panel.icon),
        component: asReact(panel.component),
      })),
    [records],
  )
  const open = useRegionOpen('panels')
  const [selected] = useUiState<string | null>(shellKeys.panel, null)
  return { open, ...shownPanels(panels, selected) }
}

/** Document renderers by kind (`documents` contributions); the Documents tab shows the rest as JSON. */
export function useDocumentRenderers() {
  const records = useExtensions()
  return useMemo(
    () =>
      new Map(
        [...documentItems(records)].map(([kind, item]) => [
          kind,
          { ...item, icon: item.icon && asReact(item.icon), component: asReact(item.component) },
        ]),
      ),
    [records],
  )
}
