/**
 * Merging a diverged clone with origin: predicting conflicts without touching the worktree, the restore ref
 * written before a merge so it can be undone, and the merge itself — never a rebase, reset or stash.
 */
import { exec } from '../../lib/exec.ts'
import type { FastForward, Git, Standing } from '../../lib/fast-forward.ts'
import { Refusal } from '../../lib/fast-forward.ts'

/**
 * Whether merging `remote` into `HEAD` would conflict, predicted by `git merge-tree --write-tree` without
 * touching the worktree; undefined when git cannot say (before 2.38, or a failing command). Its exit codes:
 * 0 merges clean, 1 conflicts, anything else unknown.
 */
export async function conflictsPredicted(
  root: string,
  remote: string,
): Promise<boolean | undefined> {
  try {
    await exec('git', ['merge-tree', '--write-tree', 'HEAD', remote], {
      cwd: root,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 120_000,
    })
    return false
  } catch (error) {
    return (error as { code?: unknown }).code === 1 ? true : undefined
  }
}

/** Where restore refs live, under their own namespace so `git tag` and `git push --tags` never see them. */
export const RESTORE_PREFIX = 'refs/ultimate-update/pre-'

/** Restore refs older than this are pruned when a new one is written. */
const KEEP_DAYS = 30

/** `ref`'s stamp (`pre-<YYYYMMDD-HHMMSS>-<sha>`, local time) as a Date, or undefined for another shape. */
const stamped = (ref: string) => {
  const match = /(\d{8})-(\d{6})-/.exec(ref.slice(RESTORE_PREFIX.length))
  if (!match) return undefined
  const [date, time] = match.slice(1)
  return new Date(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)),
    Number(time.slice(0, 2)),
    Number(time.slice(2, 4)),
    Number(time.slice(4, 6)),
  )
}

/**
 * Write `refs/ultimate-update/pre-<stamp>-<sha>` pointing at `head` before a merge, so `git reset --hard
 * <ref>` undoes it, and prune restore refs older than `KEEP_DAYS` days. The stamp in the name is the clock:
 * a ref carries no creation date of its own, and one written in the same second keeps a distinct sha.
 */
async function saveRestore(git: Git, head: string): Promise<string> {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const ref = `${RESTORE_PREFIX}${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${head.slice(0, 12)}`
  await git('update-ref', ref, head)
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60_000
  const others = (await git('for-each-ref', '--format=%(refname)', `${RESTORE_PREFIX}*`))
    .split('\n')
    .filter(Boolean)
  for (const other of others) {
    const stamp = stamped(other)
    if (!stamp || stamp.getTime() >= cutoff) continue
    // Pruning is best-effort: a ref that cannot be deleted only outlives its pruning.
    await git('update-ref', '-d', other).catch(() => undefined)
  }
  return ref
}

/** A merge that moved a diverged branch: besides `FastForward`, where the branch stood (`restore` undoes it). */
export type Merged = FastForward & { restore: string }

/**
 * Merge `origin/<branch>` into a diverged clone, in place: a restore ref first, then `git merge --no-edit`,
 * which on a conflict is aborted back to where the branch stood — nothing stashed, rebased or reset.
 * `predicted` is what `conflictsPredicted` said; a predicted conflict refuses before touching anything.
 */
export async function mergeUpstream(
  git: Git,
  predicted: boolean | undefined,
  state: Standing,
): Promise<Merged> {
  if (predicted) throw new Refusal(`merging ${state.remote} into ${state.branch} would conflict`)
  const before = await git('rev-parse', 'HEAD')
  const restore = await saveRestore(git, before)
  try {
    await git('merge', '--no-edit', state.remote)
  } catch {
    // Back where the merge started: nothing changed. The restore ref stays for a redo by hand; a failed
    // abort leaves the tree torn but checked, and the next update refuses the dirty clone instead.
    await git('merge', '--abort').catch(() => undefined)
    throw new Refusal(
      `the merge of ${state.remote} conflicted; nothing was changed. Redo it by hand, or ask @ultimate to merge it on a branch`,
    )
  }
  return {
    ...state,
    before,
    after: await git('rev-parse', 'HEAD'),
    lockfile: !!(await git('diff', '--name-only', before, state.remote, '--', 'pnpm-lock.yaml')),
    restore,
  }
}
