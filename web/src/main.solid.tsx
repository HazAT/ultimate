/** @jsxImportSource @solidjs/web */
import './index.css'
import { render } from '@solidjs/web'
import { App } from './app/App.solid.tsx'
import { loadExtensions } from './extensions.ts'
import { store, uiAgent } from './sdk/client.ts'

store.start()
addEventListener('pagehide', (event) => {
  if (event.persisted) store.stop()
})
addEventListener('pageshow', (event) => {
  if (event.persisted) store.start()
})
uiAgent.bridge()
function preventDroppedFileNavigation(event: DragEvent) {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
}
for (const name of ['dragover', 'drop'] as const)
  document.addEventListener(name, preventDroppedFileNavigation)
void loadExtensions()
render(() => <App />, document.getElementById('app')!)
