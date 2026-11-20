import { useEffect, useSyncExternalStore } from 'react'
import { useEvent, useExtensionUiState, useUltimate, writerNow, writingAs } from '@/sdk'

export const useSpec = () => useExtensionUiState<string>('spec', 'uncommitted')

export type ReviewTarget = { file: string; line: number; side?: 'old' | 'new' }

type Request = { spec: string; at?: ReviewTarget; source?: string }

const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const notify = () => {
  for (const listener of listeners) listener()
}

function fromAddress(): Request | undefined {
  const params = new URL(location.href).searchParams
  const spec = params.get('review')
  if (!spec) return undefined
  const file = params.get('file')
  const line = Number(params.get('line'))
  const side = params.get('side') === 'old' ? 'old' : undefined
  return {
    spec,
    ...(file && Number.isSafeInteger(line) && line > 0
      ? { at: { file, line, ...(side && { side }) } }
      : {}),
  }
}

let pendingReviewRequest = fromAddress()
let unreachedLineTarget: ReviewTarget | undefined

export function openReview(spec: string, at?: ReviewTarget) {
  pendingReviewRequest = { spec, ...(at && { at }), source: writerNow() }
  notify()
}

export const useTarget = () => useSyncExternalStore(subscribe, () => unreachedLineTarget)

export function reachedTarget() {
  unreachedLineTarget = undefined
  notify()
}

export function ReviewLink() {
  const wanted = useSyncExternalStore(subscribe, () => pendingReviewRequest)
  const [spec, setSpec] = useSpec()
  const { surface, showSurface } = useUltimate()
  useEvent('review:open', (data) => {
    const request = data as Request
    openReview(request.spec, request.at)
  })
  useEffect(() => {
    if (wanted === undefined) return
    pendingReviewRequest = undefined
    unreachedLineTarget = wanted.at
    writingAs(wanted.source, () => {
      setSpec(wanted.spec)
      showSurface('review')
    })
    notify()
  }, [wanted, setSpec, showSurface])
  useEffect(() => {
    if (pendingReviewRequest !== undefined) return
    const url = new URL(location.href)
    const shown = surface === 'review' ? spec : null
    if (url.searchParams.get('review') === shown) return
    if (shown === null) url.searchParams.delete('review')
    else url.searchParams.set('review', shown)

    const previousSpecLineParameters = ['file', 'line', 'side']
    for (const name of previousSpecLineParameters) url.searchParams.delete(name)
    history.replaceState(history.state, '', url)
  }, [surface, spec])
  return null
}
