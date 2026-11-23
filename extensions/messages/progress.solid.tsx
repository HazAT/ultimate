import { createMemo, mapArray } from 'solid-js'
import { ROOT, useAction } from '@/sdk/solid'
import { RemoteProgressAction } from './refs.ts'

export function useRemoteProgress(project: () => string | undefined) {
  const projects = createMemo(() => {
    const current = project()
    return current ? [current] : []
  })
  const reads = mapArray(projects, (name) =>
    useAction(RemoteProgressAction, { project: name }, { conversation: ROOT, every: 15000 }),
  )
  return () => reads()[0]?.data()
}
