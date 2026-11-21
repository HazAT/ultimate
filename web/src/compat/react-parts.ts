import { useMemo } from 'react'
import type { ComponentType } from 'react'
import { createComponent } from 'solid-js'
import type { Component as SolidComponent } from 'solid-js'
import { shellKeys } from '../sdk/actions.ts'
import { rendersInReact } from '../sdk/framework.ts'
import { documentItems, panelItems, shownPanels } from '../sdk/registry.ts'
import { useExtensions, useRegionOpen, useUiState } from './hooks.ts'
import { island } from './island.tsx'
import type { DocumentContribution, DocumentProps, PanelContribution } from './types.ts'

type Icon = NonNullable<PanelContribution['icon']>

const components = new WeakMap<object, ComponentType<never>>()
const icons = new WeakMap<object, Icon>()

const component = <P extends object>(part: unknown): ComponentType<P> => {
  if (rendersInReact(part)) return part as ComponentType<P>
  const key = part as object
  if (!components.has(key)) components.set(key, island(part as SolidComponent<P>) as never)
  return components.get(key) as ComponentType<P>
}

const icon = (part: unknown): Icon => {
  if (rendersInReact(part)) return part as Icon
  const key = part as object
  if (!icons.has(key))
    icons.set(
      key,
      island((props: { className?: string }) =>
        createComponent(part as SolidComponent<{ class?: string }>, {
          get class() {
            return props.className
          },
        }),
      ) as Icon,
    )
  return icons.get(key)!
}

/** A tab of the right panel, with the extension that contributed it. */
export interface PanelItem extends PanelContribution {
  extension: string
  version: number
}

/** How the Documents tab shows one kind of document, with the extension that contributed it. */
export interface DocumentItem extends DocumentContribution {
  extension: string
  version: number
}

/**
 * The right panel's state: whether it is open, the panel it shows (the chosen one, else the first with a tab) and the
 * panels in its tab row.
 */
export function usePanels() {
  const records = useExtensions()
  const panels = useMemo(
    () =>
      panelItems(records).map((panel): PanelItem => ({
        ...panel,
        icon: panel.icon && icon(panel.icon),
        component: component(panel.component),
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
        [...documentItems(records)].map(([kind, item]): [string, DocumentItem] => [
          kind,
          {
            ...item,
            icon: item.icon && icon(item.icon),
            component: component<DocumentProps>(item.component),
          },
        ]),
      ),
    [records],
  )
}
