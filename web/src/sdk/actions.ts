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

/** Shell state that survives reloads and follows across tabs (see ui-state.ts). */
export const shellKeys = {
  conversation: 'shell.conversation',
  /** The chosen surface's id. */
  surface: 'shell.surface',
  /** `{ id, title }` of the surface on screen: what rendered, so Agent after a chosen surface that failed. */
  shownSurface: 'shell.shownSurface',
  panel: 'shell.panel',
  panelOpen: 'shell.panelOpen',
  sidebarOpen: 'shell.sidebarOpen',
  /** `{ open, width }` of a surface's `Dock`, under `shell.dock.<surface id>.<side>`. */
  dock: 'shell.dock',
} as const

/** The shown surface, from the installed facets, the chosen id, and the project's `defaultSurface`; now by default. */
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

/**
 * Regions the shown surface renders (`Sidebar`, `Panels` mount themselves here); their header toggles and commands
 * exist only while they do.
 */
const regions = new Map<'sidebar' | 'panels', number>()
const regionListeners = new Set<() => void>()
export const layout = {
  mount: (region: 'sidebar' | 'panels') => {
    regions.set(region, (regions.get(region) ?? 0) + 1)
    for (const listener of regionListeners) listener()
    return () => {
      regions.set(region, (regions.get(region) ?? 1) - 1)
      for (const listener of regionListeners) listener()
    }
  },
  has: (region: 'sidebar' | 'panels') => (regions.get(region) ?? 0) > 0,
  subscribe: (listener: () => void) => {
    regionListeners.add(listener)
    return () => {
      regionListeners.delete(listener)
    }
  },
}

export type Region = 'sidebar' | 'panels'
/** The shared open state of each region, and its default. */
export const regionKeys = {
  sidebar: [shellKeys.sidebarOpen, true],
  panels: [shellKeys.panelOpen, false],
} as const

/**
 * Whether `region` starts open in this tab below a desktop: only a tablet's sidebar, which docks (an unfolded
 * foldable shows the chats beside the conversation).
 */
export const ownDefault = (region: Region, on: Viewport) => on === 'tablet' && region === 'sidebar'

/** Whether `region` is open: shared on a desktop, this tab's own (`ownDefault`) below it. */
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
  // Overlays never stack: opening one closes the other.
  const close = open && overlays(region, on) && overlays(other, on)
  const all = store.getState().ui.open
  store.setUi({
    open: { ...all, [on]: { ...all?.[on], [region]: open, ...(close && { [other]: false }) } },
  })
}

/** Going somewhere else closes what overlays the conversation, so it shows. */
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
  // The shown conversation's composer, unless something covers it (`inert`), such as a side chat in front of it.
  focusComposer: () =>
    [
      document.getElementById('composer-input'),
      ...document.querySelectorAll('[data-composer-target] textarea'),
    ]
      .find(
        (input): input is HTMLElement => input instanceof HTMLElement && !input.closest('[inert]'),
      )
      ?.focus(),
  setTheme: (theme) => store.setUi({ theme }),
}

/** Run command `id` in `context`, reporting a failure as a notice; shortcuts pass the context of where they were typed. */
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

/** The shell's context; `scoped` is the `ConversationScope` a shortcut was typed in, which it acts on instead. */
export function currentContext(scoped?: number): UltimateContext {
  return {
    ...actions,
    conversationId: scoped ?? store.getState().view?.conversation.id,
    surface: store.getState().ui.surface?.id ?? HOME,
  }
}

const reported = new Set<string>()
/** `commandApplies` that reports a broken `when` once as a notice naming its extension. */
export function applies(command: CommandItem, context: UltimateContext = currentContext()) {
  return commandApplies(command, context, (item, error) => {
    const message = `extension ${item.extension}: command ${item.id} is hidden, its when() threw: ${errorMessage(error)}`
    if (reported.has(message)) return
    reported.add(message)
    // Predicates run while React renders the palette; notify after that render.
    queueMicrotask(() => store.notify({ level: 'error', message }))
  })
}

/** The shell's own commands: the palette and its regions. Feature commands come from their extensions. */
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

/** Core commands, a switch per surface (`mod+1…9` for the first nine), then extension commands; later wins an id. */
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
