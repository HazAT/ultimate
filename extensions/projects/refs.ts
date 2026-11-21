/** Projects in the browser: Ultimate instances on this machine and in the user's remotes. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** One instance: its project's name, its loopback or configured remote URL, and its live state when it answered. */
export type RunningProject = {
  name: string
  url: string
  /** The instance this page shows. */
  current: boolean
  /** The machine named in user settings for a remote instance; absent for this machine's instances. */
  machine?: string
  /** Its status could not be read; live counts are absent, not zero. */
  unavailable?: true
  /**
   * Its `origin` on GitHub, `<owner>/<repo>` as GitHub spells it, with its visibility when `gh` knew it; absent off
   * GitHub and until the first read finished.
   */
  repo?: { name: string; url: string; visibility?: 'public' | 'private' | 'internal' }
  /** Conversations running a turn now; absent when its `status` did not answer. */
  busy?: number
  /** Messages waiting on the user's answer; absent when its `status` did not answer. */
  questions?: number
  /** Its HTTPS port on the tailnet, when Tailscale registered one: where a page opened over the tailnet reaches it. */
  tailnetPort?: number
}

/** No arguments → running instances in local project order, then configured remotes in machine/project order. */
export const ListAction = actionRef<null, RunningProject[]>('projects', 'list')

/** `{ pinned? }` → whether the rail stays open, shared by every instance on this machine; `pinned` sets it first. */
export const PinAction = actionRef<{ pinned?: boolean }, { pinned: boolean }>('projects', 'pin')
