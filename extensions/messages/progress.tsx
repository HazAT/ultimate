import { useAction } from '@/sdk'
import { RemoteProgressAction } from './refs.ts'

export function useRemoteProgress(project = '') {
  return useAction(RemoteProgressAction, { project }, { enabled: !!project, every: 15000 })
}
