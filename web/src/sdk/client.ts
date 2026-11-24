import { parseConversationId } from '../../../lib/ids.ts'
import type { ConversationId } from '@earendil-works/pi-durable'
import { ActionError, actionMessage, createApi } from './api.ts'
import { createReads } from './reads.ts'
import { errorMessage } from './format.ts'
import { deadline } from '../../../lib/timers.ts'
import { linkedConversation } from './link.ts'
import { HOME, createRegistry } from './registry.ts'
import { createStore } from './store.ts'
import { createTestHook } from './test-hook.ts'
import { createUiAgent } from './agent.ts'
import { agentsPage } from './writer.ts'
import { firstRender } from './resume.ts'
import { createUiState, tabWrites } from './ui-state.ts'

const initialUrl = new URL(location.href)
let initialUrlSelectionResolved = false
let replaceSelection = true
let selected: number | undefined

function urlConversation() {
  const value = new URL(location.href).searchParams.get('conversation')
  const id = value && /^\d+$/.test(value) ? Number(value) : undefined
  return id !== undefined && Number.isSafeInteger(id) && id > 0 ? id : undefined
}
function writeConversation(id: ConversationId, replace: boolean) {
  const url = new URL(location.href)
  if (url.searchParams.get('conversation') === String(id)) return
  url.searchParams.set('conversation', String(id))
  if (replace) history.replaceState(history.state, '', url)
  else history.pushState(history.state, '', url)
}

export const store = createStore({
  ui: {
    theme: localStorage.getItem('ultimate.theme') === 'light' ? 'light' : 'dark',
  },
  onFallback: () => {
    replaceSelection = true
    uiState.delete('shell.conversation')
  },
})
const driven = sessionStorage.getItem('ultimate.driven') === '1'
if (driven) agentsPage()

export const api = createApi(store)

export const reads = createReads(api, store)

const { shares: followsSharedUiState, ...tabOnly } = tabWrites({
  driven,
  detached: sessionStorage.getItem('ultimate.detached') === '1',
  webdriver: navigator.webdriver,
})

export const uiState = createUiState(followsSharedUiState ? api.updateUi : undefined, {
  onError: (error) =>
    store.notify({
      level: 'error',
      message: `UI state not saved: ${String(error)}`,
    }),
  ...tabOnly,
})

export const uiAgent = createUiAgent()

export const registry = createRegistry()

if (driven)
  window.ultimate = createTestHook(store, api, uiAgent, uiState, firstRender, (signal) =>
    reads.settledInUse(signal),
  )

export const bundle = document.querySelector<HTMLMetaElement>('meta[name=ultimate-web]')?.content

const reloadNoticeMs = 600
let switching = false
let reloadHolds = 0
let reloadWaits = false

function reloadUnlessHeld() {
  if (reloadHolds) reloadWaits = true
  else location.reload()
}

/** Keeps the page from switching to a new bundle until the returned release runs (a recording in progress). */
export function holdReload() {
  reloadHolds++
  let released = false
  return () => {
    if (released) return
    released = true
    reloadHolds--
    if (!reloadHolds && reloadWaits) location.reload()
  }
}

const switchKey = 'ultimate.web-switch'
export const switched = ((): { at: number; changed: string[] } | undefined => {
  const stored = sessionStorage.getItem(switchKey)
  sessionStorage.removeItem(switchKey)
  const value = stored ? (JSON.parse(stored) as { at: number; changed: string[] }) : undefined
  return value && Date.now() - value.at < 30000 ? value : undefined
})()

let uiStateServerProcess: string | undefined

let previousProcessUiSnapshot: unknown

function resetRevisionsBeforeUiSnapshot(process: string | undefined, shared: unknown) {
  if (process !== uiStateServerProcess) {
    if (uiStateServerProcess !== undefined) {
      uiState.restarted()
      previousProcessUiSnapshot = shared
    }
    uiStateServerProcess = process
  }
}

store.subscribe(() => {
  const { shared, ui, system } = store.getState()
  if (system && !registry.getReady().ready) registry.receiveSystem()

  if (system?.web.id && bundle && system.web.id !== bundle) {
    if (switching) return
    switching = true
    sessionStorage.setItem(
      switchKey,
      JSON.stringify({ at: Date.now(), changed: system.web.changed }),
    )
    deadline(reloadNoticeMs, reloadUnlessHeld)
    return
  }

  const process = system && `${system.process.pid}:${system.process.generation}`
  resetRevisionsBeforeUiSnapshot(process, shared)
  if (shared && shared !== previousProcessUiSnapshot) {
    if (!initialUrlSelectionResolved) {
      uiState.receive(shared)
      if (initialUrl.searchParams.has('conversation')) {
        const id = urlConversation()
        if (id === undefined) uiState.delete('shell.conversation')
        else uiState.set('shell.conversation', id)
      }
      const navigation = performance.getEntriesByType('navigation')[0] as
        | PerformanceNavigationTiming
        | undefined
      if (linkedConversation(initialUrl, navigation?.type)) uiState.set('shell.surface', HOME)
      initialUrlSelectionResolved = true
      followSelection()
    } else if (followsSharedUiState) uiState.receive(shared)
  }

  const { view, requested } = store.getState()
  const chosenConversationHasSnapshot =
    initialUrlSelectionResolved && view && requested === view.conversation.id
  if (chosenConversationHasSnapshot) {
    writeConversation(view.conversation.id, true)
    replaceSelection = false
  }

  localStorage.setItem('ultimate.theme', ui.theme)
  document.documentElement.classList.toggle('dark', ui.theme === 'dark')

  document
    .querySelector('meta[name=theme-color]')
    ?.setAttribute('content', ui.theme === 'dark' ? '#111112' : '#f9fafb')
})

const compactFailures = new Set<string>()

export function reportCompact(extension: string, error: unknown) {
  const failure = `extension ${extension}: compact is off, its when() threw: ${errorMessage(error)}`
  if (compactFailures.has(failure)) return
  compactFailures.add(failure)
  queueMicrotask(() => store.notify({ level: 'error', message: failure }))
}

export function replaceNextSelection() {
  replaceSelection = true
}

function followSelection() {
  if (!initialUrlSelectionResolved) return
  const value = uiState.get('shell.conversation')
  const id = typeof value === 'number' ? parseConversationId(value) : undefined
  if (id !== selected) {
    selected = id
    if (id !== undefined) writeConversation(id, replaceSelection)
  }
  store.show(id)
  replaceSelection = false
}
uiState.subscribe(followSelection)
addEventListener('popstate', () => {
  replaceSelection = true
  const id = urlConversation()
  if (id === undefined) uiState.delete('shell.conversation')
  else uiState.set('shell.conversation', id)

  followSelection()
  const { view, requested } = store.getState()
  if (view && requested === view.conversation.id) {
    writeConversation(view.conversation.id, true)
    replaceSelection = false
  }
})
addEventListener('pagehide', () => void uiState.exit())

addEventListener('unhandledrejection', (event) => {
  if (!(event.reason instanceof ActionError)) return
  event.preventDefault()
  store.notify({ level: 'error', message: actionMessage(event.reason) })
})
