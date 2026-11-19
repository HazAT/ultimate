/** Update in the browser: whether the Ultimate clone is behind origin, and updating it. Browser-safe. */
import type { ConversationId } from '@earendil-works/pi-durable'
import { actionRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'

/** Which layers a range touches, by how they go live (AGENTS.md "Layers and how they reload"). */
export type Layers = {
  /** `server/` or `shared/`: the restart swap. */
  core: boolean
  /** `bin/`: a human restart of the supervisor. */
  bin: boolean
  /** `pnpm-lock.yaml` or `patches/`: an install, then a restart. */
  lockfile: boolean
  /** Anything else (`extensions/`, `web/`, `lib/`, `agents/`, docs): hot reload. */
  live: boolean
}

export type UpdateState = {
  /** The clone Ultimate runs from. */
  root: string
  /** Its default branch, e.g. `main`. */
  branch?: string
  /** The clone's HEAD commit. Absent on a preview, which never reads the clone. */
  head?: string
  /** Commits on `origin/<branch>` that the clone lacks, as of the last fetch. */
  behind: number
  /** Commits of the clone's own that origin lacks. */
  ahead?: number
  /** The newest of them (at most 5), newest first. */
  commits: { sha: string; subject: string }[]
  /** 2–4 plain lines on what the range brings, from the summary model; absent without one. */
  summary?: string[]
  /** What those commits touch. */
  layers?: Layers
  /** DiffsHub's view of the range, for a GitHub origin. */
  compare?: string
  /** Why Update refuses: uncommitted changes, another branch, diverged, the lander landing. */
  refused?: string
  /**
   * The only refusal is a diverged branch, and the clone is the project this Ultimate serves: `merge` asks @ultimate to
   * merge origin into it through a branch the lander lands.
   */
  merge?: true
  /** Why the last fetch failed; the counts are from the fetch before. */
  error?: string
  /** When origin was last fetched (ms), by any Ultimate on this clone. */
  fetchedAt?: number
  /** `pnpm-lock.yaml` differs from the installed packages, or the last install failed: an install is owed. */
  install: boolean
  /** Packages were installed, or `server/` or `shared/` changed in HEAD, since this server started: a restart loads them. */
  restart: boolean
  /** The last update this server made, until it restarts. */
  updated?: UpdateResult & { ok: true }
  /** A preview of another Ultimate: it never checks or updates the clone, and shows no item. */
  preview?: true
}

export type UpdateResult =
  | {
      ok: true
      from: string
      to: string
      commits: number
      layers: Layers
      install: 'done' | 'failed' | 'skipped'
      /** The install's last output lines when it failed. */
      installError?: string
    }
  | { ok: false; refused: string }

/** One instance's restart in a `restartAll`: never `ok` unless the generation it announced is the one serving there. */
export type RestartOutcome = {
  /** The project's name, as its folder spells it. */
  name: string
  url: string
  ok: boolean
  /** The generation it announced when it accepted the restart. */
  generation?: number
  /** Why it refused, did not answer, or did not come back on the generation it announced. */
  error?: string
}

export type RestartAllResult = {
  at: number
  /** Why no instance was asked: a preview, or a restart within the last few minutes. */
  refused?: string
  /** One per instance asked, in the order they were asked. */
  outcomes: RestartOutcome[]
}

/** No arguments → the clone's update state, from the last fetch (fetched hourly in the background). */
export const StateAction = actionRef<null, UpdateState>('update', 'state')
/** No arguments → fetch origin now (bypassing the hourly gate, under the clone's lock), then the refreshed state. */
export const CheckAction = actionRef<null, UpdateState>('update', 'check')
/**
 * Fetch origin, fast-forward the clone's default branch and install when the lockfile changed. Refuses a
 * dirty, diverged or switched clone and while the lander lands into it; never stashes, rebases or resets.
 */
export const UpdateAction = actionRef<null, UpdateResult>('update', 'update')
/**
 * The user's alone: ask @ultimate to merge `origin/<branch>` into the diverged clone through a coordinator branch;
 * @ultimate's conversation id. Only while `merge` is offered.
 */
export const MergeAction = actionRef<null, { id: ConversationId }>('update', 'merge')
/**
 * No arguments → restart every other instance running this clone that owes a restart, one after another, proving each
 * by the generation it announces and then serves. The instance answering is not restarted: its window keeps Restart
 * now. Refused within a few minutes of the last attempt. User-only.
 */
export const RestartAllAction = actionRef<null, RestartAllResult>('update', 'restartAll')

/**
 * The clone fast-forwarded `from..to` (`commits` commits) touching `layers`; `install` says whether packages were
 * installed. The clone lives outside storage, so this commits on its own right after the change.
 */
export const Applied = defineEvent<{
  root: string
  from: string
  to: string
  commits: number
  layers: Layers
  install: 'done' | 'failed' | 'skipped'
}>('update.applied')
/** Update was refused for `reason` (uncommitted changes, another branch, diverged, the lander landing). */
export const Refused = defineEvent<{ root: string; reason: string }>('update.refused')
