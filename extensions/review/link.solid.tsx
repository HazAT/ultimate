import { createEffect, onSettled } from 'solid-js'
import {
  showSurface,
  useEvent,
  useExtensionUiState,
  useExternal,
  useStore,
  writingAs,
} from '@/sdk/solid'
import { defaultSpec, getTarget, setTarget, specKey, subscribeTarget } from './link-state.ts'
import type { ReviewRequest } from './link-state.ts'

function fromAddress(): ReviewRequest | undefined {
  const params = new URL(location.href).searchParams
  const spec = params.get('review')
  if (!spec) return undefined
  const file = params.get('file')
  const line = Number(params.get('line'))
  const side = params.get('side') === 'old' ? 'old' : undefined
  return {
    spec,
    at: file && Number.isSafeInteger(line) && line > 0 ? { file, line, side } : undefined,
  }
}

export const useSpec = () => useExtensionUiState(specKey, defaultSpec)

export const useTarget = () => useExternal(getTarget, subscribeTarget)

export function ReviewLink() {
  const [selectedSpec, setSpec] = useSpec()
  const shownSurface = useStore((state) => state.ui.surface?.id)
  const open = (request: ReviewRequest) => {
    setTarget(request.at)
    setSpec(request.spec)
    showSurface('review')
  }
  useEvent('review:open', (request) => open(request as ReviewRequest))

  const initial = fromAddress()
  let openingFromAddress = initial !== undefined
  onSettled(() => {
    if (initial) writingAs('app', () => open(initial))
  })
  createEffect(
    () => ({ surface: shownSurface(), spec: selectedSpec() }),
    ({ surface, spec }) => {
      if (!surface || (openingFromAddress && surface !== 'review')) return
      openingFromAddress = false
      const url = new URL(location.href)
      const shown = surface === 'review' ? spec : null
      if (url.searchParams.get('review') === shown) return
      if (shown === null) url.searchParams.delete('review')
      else url.searchParams.set('review', shown)
      for (const name of ['file', 'line', 'side']) url.searchParams.delete(name)
      history.replaceState(history.state, '', url)
    },
  )
  return null
}
