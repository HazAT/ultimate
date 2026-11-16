import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.tsx'
import { loadExtensions } from './extensions.ts'
import { store } from './sdk/client.ts'

store.start()
function preventDroppedFileNavigation(event: DragEvent) {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
}
for (const name of ['dragover', 'drop'] as const)
  document.addEventListener(name, preventDroppedFileNavigation)
void loadExtensions()
createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
