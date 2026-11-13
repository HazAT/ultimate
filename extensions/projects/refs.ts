/** Projects in the browser: the Ultimate instances running on this machine, for the rail. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** One running instance: its project's name, its loopback URL, and its live state when it answered. */
export type RunningProject = {
  name: string
  url: string
  /** The instance this page shows. */
  current: boolean
  /**
   * Its `origin` on GitHub, `<owner>/<repo>` as GitHub spells it, with its visibility when `gh` knew it; absent off
   * GitHub and until the first read finished.
   */
  repo?: { name: string; url: string; visibility?: 'public' | 'private' | 'internal' }
  /** Conversations running a turn now; absent when its `status` did not answer. */
  busy?: number
  /** Messages waiting on the user's answer; absent when its `status` did not answer. */
  questions?: number
}

/** No arguments → every running instance on this machine, this one included, in project order. */
export const ListAction = actionRef<null, RunningProject[]>('projects', 'list')

/** `{ pinned? }` → whether the rail stays open, shared by every instance on this machine; `pinned` sets it first. */
export const PinAction = actionRef<{ pinned?: boolean }, { pinned: boolean }>('projects', 'pin')
