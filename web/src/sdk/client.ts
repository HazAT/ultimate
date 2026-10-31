import { ActionError, actionMessage, createApi } from './api.ts'
import { createRegistry } from './registry.ts'
import { createStore } from './store.ts'
import { createTestHook } from './test-hook.ts'
import type { TestHook } from './test-hook.ts'
import type { Notice } from '../../../shared/protocol.ts'

declare global {
  interface Window {
    ultimate?: TestHook
  }
}
import { createUiState } from './ui-state.ts'

const initialUrl = new URL(location.href)
let initialized = false
let replaceSelection = true
let selected: number | undefined

function urlConversation() {
  const value = new URL(location.href).searchParams.get('conversation')
  const id = value && /^\d+$/.test(value) ? Number(value) : undefined
  return id !== undefined && Number.isSafeInteger(id) && id > 0 ? id : undefined
}
function writeConversation(id: number, replace: boolean) {
  const url = new URL(location.href)
  if (url.searchParams.get('conversation') === String(id)) return
  url.searchParams.set('conversation', String(id))
  if (replace) history.replaceState(history.state, '', url)
  else history.pushState(history.state, '', url)
}

/** The page's one live stream and its replica. */
export const store = createStore({
  ui: {
    theme: localStorage.getItem('ultimate.theme') === 'light' ? 'light' : 'dark',
  },
  onFallback: () => {
    replaceSelection = true
    uiState.delete('shell.conversation')
  },
})
/** Server commands; conversation commands default to the shown conversation. */
export const api = createApi(store)
/** Report an outcome the user should see, as the shell's notices do: `notify({ level: 'info', message })`. */
export const notify = (notice: Notice) => store.notify(notice)
/**
 * A page an agent drives (the `screenshot` and `browser` tools mark it) looks at the UI without steering the user's
 * tabs: it reads the shared state once, then its selection and panels are its own, never written or followed.
 */
const detached = sessionStorage.getItem('ultimate.detached') === '1'
/** Durable UI state shared by every tab, fed by the stream (see ui-state.ts). */
export const uiState = createUiState(detached ? undefined : api.updateUi, {
  onError: (error) =>
    store.notify({
      level: 'error',
      message: `UI state not saved: ${String(error)}`,
    }),
})
// A page the browser tool drives, here or on a preview, waits on state through `window.ultimate` (test-hook.ts).
if (sessionStorage.getItem('ultimate.driven') === '1') window.ultimate = createTestHook(store, api)
/** Installed web facets of `extensions/*`. */
export const registry = createRegistry()

/** The server process the UI state came from: another one may have started from other storage. */
let server: string | undefined
/** The previous process's UI state, still in the store until the new stream's `ui` replaces it. */
let stale: unknown
store.subscribe(() => {
  const { shared, ui, system } = store.getState()
  if (system && !registry.getReady().ready) registry.receiveSystem()
  // The stream sends `system` before `ui`, so a new process's snapshot finds the revisions forgotten.
  const process = system && `${system.process.pid}:${system.process.generation}`
  if (process !== server) {
    if (server !== undefined) {
      uiState.restarted()
      stale = shared
    }
    server = process
  }
  if (shared && shared !== stale) {
    if (!initialized) {
      // Receive the saved shell first, but do not follow it until the explicit URL has won.
      uiState.receive(shared)
      if (initialUrl.searchParams.has('conversation')) {
        const id = urlConversation()
        if (id === undefined) uiState.delete('shell.conversation')
        else uiState.set('shell.conversation', id)
      }
      initialized = true
      followSelection()
    } else if (!detached) uiState.receive(shared)
  }
  // Only a chosen conversation goes into the URL: the stream's fallback to the root is not a choice, and a reload of
  // `?conversation=1` would make it one (a fresh preview's Vite reloads once), keeping the page off @ultimate.
  const { view, requested } = store.getState()
  if (initialized && view && requested === view.conversation.id) {
    writeConversation(view.conversation.id, true)
    replaceSelection = false
  }
  // The theme is a preference of this browser.
  localStorage.setItem('ultimate.theme', ui.theme)
  document.documentElement.classList.toggle('dark', ui.theme === 'dark')
  // The browser bar and the installed app's chrome take the page background (web/index.html).
  document
    .querySelector('meta[name=theme-color]')
    ?.setAttribute('content', ui.theme === 'dark' ? '#111112' : '#f9fafb')
})
/** The next selection replaces the current history entry rather than pushing one, as a redirect does. */
export function replaceNextSelection() {
  replaceSelection = true
}
// The stream follows `shell.conversation`, whichever tab or action set it.
function followSelection() {
  if (!initialized) return
  const value = uiState.get('shell.conversation')
  const id = typeof value === 'number' ? value : undefined
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
  // An unchanged selection emits no notification, but may still need URL canonicalization.
  followSelection()
  const { view, requested } = store.getState()
  if (view && requested === view.conversation.id) {
    writeConversation(view.conversation.id, true)
    replaceSelection = false
  }
})
addEventListener('pagehide', () => uiState.flush())
// An action failure no caller handled: show it rather than lose it in the console.
addEventListener('unhandledrejection', (event) => {
  if (!(event.reason instanceof ActionError)) return
  event.preventDefault()
  store.notify({ level: 'error', message: actionMessage(event.reason) })
})

// These singletons own the live stream: a change to them reloads the page rather than run a second copy. The new
// module only constructs (nothing connects before `start()`), then the page reloads.
import.meta.hot?.accept(() => location.reload())
