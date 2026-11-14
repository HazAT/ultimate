import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.tsx'
import { loadExtensions } from './extensions.ts'
import { store } from './sdk/client.ts'

store.start()
// A file dropped anywhere on the page would make the browser navigate to it, replacing the shell; a handler that takes
// drops still gets them, since cancelling the default does not stop the event.
for (const name of ['dragover', 'drop'] as const)
  document.addEventListener(name, (event) => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
  })
void loadExtensions()
createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
