import { overshadowed } from '../../lib/errors.ts'
import { exec } from '../../lib/exec.ts'
import type { FastForward, Git, Standing } from '../../lib/fast-forward.ts'
import { Refusal } from '../../lib/fast-forward.ts'

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

export const RESTORE_PREFIX = 'refs/ultimate-update/pre-'

const KEEP_DAYS = 30

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
    await git('update-ref', '-d', other).catch(overshadowed)
  }
  return ref
}

export type Merged = FastForward & { restore: string }

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
    let undone = true
    try {
      await git('merge', '--abort')
    } catch {
      undone = false
    }
    if (undone) await git('update-ref', '-d', restore).catch(overshadowed)
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
