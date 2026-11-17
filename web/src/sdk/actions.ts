import type { ConversationId } from '@earendil-works/pi-durable'
import { registry, replaceNextSelection, store, uiState } from './client.ts'
import { errorMessage } from './format.ts'
import {
  HOME,
  commandApplies,
  commandItems,
  panelItems,
  resolveSurface,
  slotItems,
  surfaceItems,
} from './registry.ts'
import type { CommandItem } from './registry.ts'
import type { CommandContribution, UltimateActions, UltimateContext } from './types.ts'
import { overlays, viewport } from './viewport.ts'
import type { Viewport } from './viewport.ts'

export const shellKeys = {
  conversation: 'shell.conversation',

  surface: 'shell.surface',

  shownSurface: 'shell.shownSurface',
  panel: 'shell.panel',
  panelOpen: 'shell.panelOpen',
  sidebarOpen: 'shell.sidebarOpen',

  dock: 'shell.dock',
} as const

export function shownSurface(
  records = registry.getSnapshot(),
  chosen = uiState.get(shellKeys.surface),
  preferred = store.getState().system?.project.settings.defaultSurface,
) {
  return resolveSurface(surfaceItems(records), {
    chosen: typeof chosen === 'string' ? chosen : undefined,
    preferred: typeof preferred === 'string' ? preferred : undefined,
    loading: records.some((record) => record.loading),
  })
}

const mountedRegionCounts = new Map<'sidebar' | 'panels', number>()
const regionListeners = new Set<() => void>()
export const layout = {
  mount: (region: 'sidebar' | 'panels') => {
    mountedRegionCounts.set(region, (mountedRegionCounts.get(region) ?? 0) + 1)
    for (const listener of regionListeners) listener()
    return () => {
      mountedRegionCounts.set(region, (mountedRegionCounts.get(region) ?? 1) - 1)
      for (const listener of regionListeners) listener()
    }
  },
  has: (region: 'sidebar' | 'panels') => (mountedRegionCounts.get(region) ?? 0) > 0,
  subscribe: (listener: () => void) => {
    regionListeners.add(listener)
    return () => {
      regionListeners.delete(listener)
    }
  },
}

export type Region = 'sidebar' | 'panels'

export const regionKeys = {
  sidebar: [shellKeys.sidebarOpen, true],
  panels: [shellKeys.panelOpen, false],
} as const

export const ownDefault = (region: Region, on: Viewport) => on === 'tablet' && region === 'sidebar'

export function regionOpen(region: Region) {
  const on = viewport()
  if (on !== 'desktop') return store.getState().ui.open?.[on]?.[region] ?? ownDefault(region, on)
  const [key, fallback] = regionKeys[region]
  const value = uiState.get(key)
  return typeof value === 'boolean' ? value : fallback
}

function setRegionOpen(region: Region, open: boolean) {
  const on = viewport()
  if (on === 'desktop') return uiState.set(regionKeys[region][0], open)
  const other = region === 'sidebar' ? 'panels' : 'sidebar'

  const closeOtherOverlayToPreventStacking = open && overlays(region, on) && overlays(other, on)
  const all = store.getState().ui.open
  store.setUi({
    open: {
      ...all,
      [on]: {
        ...all?.[on],
        [region]: open,
        ...(closeOtherOverlayToPreventStacking && { [other]: false }),
      },
    },
  })
}

function closeOverlays() {
  for (const region of ['sidebar', 'panels'] as const)
    if (overlays(region) && regionOpen(region)) setRegionOpen(region, false)
}

export const actions: UltimateActions = {
  switchConversation: (id, options) => {
    closeOverlays()
    if (options?.replace) replaceNextSelection()
    uiState.set(shellKeys.conversation, id)
  },
  showSurface: (id) => {
    closeOverlays()
    uiState.set(shellKeys.surface, id)
  },
  openPanel: (id) => {
    setRegionOpen('panels', true)
    if (id) uiState.set(shellKeys.panel, id)
  },
  closePanel: () => setRegionOpen('panels', false),
  togglePanel: () => setRegionOpen('panels', !regionOpen('panels')),
  toggleSidebar: () => setRegionOpen('sidebar', !regionOpen('sidebar')),
  runCommand: (id) => runCommand(id),
  open: (dialog) => store.setUi({ dialogs: { ...store.getState().ui.dialogs, [dialog]: true } }),
  close: (dialog) => store.setUi({ dialogs: { ...store.getState().ui.dialogs, [dialog]: false } }),
  openPalette: () => store.setUi({ paletteOpen: true }),

  focusComposer: () =>
    [
      document.getElementById('composer-input'),
      ...document.querySelectorAll('[data-composer-target] textarea'),
    ]
      .find(function isUncoveredComposer(input): input is HTMLElement {
        return input instanceof HTMLElement && !input.closest('[inert]')
      })
      ?.focus(),
  setTheme: (theme) => store.setUi({ theme }),
}

export function runCommand(id: string, context: UltimateContext = currentContext()) {
  const command = allCommands().find((candidate) => candidate.id === id)
  if (!command || !applies(command, context)) return
  void Promise.resolve()
    .then(() => command.run(context))
    .catch((error: unknown) =>
      store.notify({
        level: 'error',
        message: `${command.title}${command.extension === 'core' ? '' : ` (${command.extension})`}: ${errorMessage(error)}`,
      }),
    )
}

export function currentContext(scoped?: ConversationId): UltimateContext {
  return {
    ...actions,
    conversationId: scoped ?? store.getState().view?.conversation.id,
    surface: store.getState().ui.surface?.id ?? HOME,
  }
}

const reported = new Set<string>()

export function applies(command: CommandItem, context: UltimateContext = currentContext()) {
  return commandApplies(command, context, (item, error) => {
    const message = `extension ${item.extension}: command ${item.id} is hidden, its when() threw: ${errorMessage(error)}`
    if (reported.has(message)) return
    reported.add(message)

    queueMicrotask(() => store.notify({ level: 'error', message }))
  })
}

const core: CommandContribution[] = [
  {
    id: 'ultimate.palette',
    title: 'Command palette',
    keys: 'mod+k',
    run: (context) => context.openPalette(),
  },
  {
    id: 'ultimate.panel',
    title: 'Toggle the right panel',
    keys: 'mod+alt+b',
    when: () => layout.has('panels') && panelItems(registry.getSnapshot()).length > 0,
    run: (context) => context.togglePanel(),
  },
  {
    id: 'ultimate.sidebar',
    title: 'Toggle the sidebar',
    keys: 'mod+b',
    when: () => layout.has('sidebar') && slotItems(registry.getSnapshot(), 'sidebar').length > 0,
    run: (context) => context.toggleSidebar(),
  },
]
const coreCommands: CommandItem[] = core.map((command) => ({
  ...command,
  group: 'Ultimate',
  extension: 'core',
}))

export function allCommands(records = registry.getSnapshot()): CommandItem[] {
  return commandItems(records, [
    ...coreCommands,
    ...surfaceItems(records).map((surface, index) => ({
      id: `ultimate.surface.${surface.id}`,
      title: `Switch to ${surface.title}`,
      keys: index < 9 ? `mod+${index + 1}` : undefined,
      group: 'Surfaces',
      extension: surface.extension,
      run: () => actions.showSurface(surface.id),
    })),
  ])
}
