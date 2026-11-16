import { implementAction } from '../../lib/actions.ts'
import { meansNone } from '../../lib/errors.ts'
import { locate, postAction } from '../../lib/remote.ts'
import { RemoteProgressAction } from './refs.ts'
import type { RemoteProgress } from './refs.ts'

const REMOTE_PROGRESS_TIMEOUT_MS = 1_500

export const remoteProgress = implementAction(
  RemoteProgressAction,
  async (args, { host, signal }) => {
    const project =
      args && typeof args === 'object' && !Array.isArray(args) ? args.project : undefined
    if (typeof project !== 'string' || !project.trim())
      throw new Error('project must name another project')
    const target = await locate(host, project).catch(meansNone)
    if (!target || 'current' in target) return { reachable: false }
    const status = (await postAction(
      target,
      'status',
      'status',
      {},
      AbortSignal.any([signal, AbortSignal.timeout(REMOTE_PROGRESS_TIMEOUT_MS)]),
    ).catch(meansNone)) as { progress?: RemoteProgress['progress'] } | undefined
    return status === undefined
      ? { reachable: false }
      : { reachable: true, ...(status.progress ? { progress: status.progress } : {}) }
  },
)
