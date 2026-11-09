import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConversationId, ToolExecutionApi } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type { createBashTool } from '@earendil-works/pi-durable/tools'
import type { EventToken } from '../../../../shared/events.ts'
import codingTools from '../../server.ts'
import { Committed } from '../../refs.ts'
import { context } from '../../../../server/harness.ts'
import { removeTemp, temp } from '../../../../test/helpers.ts'

const run = promisify(execFile)
type Event = typeof Committed extends EventToken<infer D> ? D : never

let cwd: string
let emitted: Event[]
const git = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim()

beforeEach(async () => {
  cwd = await realpath(await temp('ultimate-commit-events-'))
  emitted = []
  await git('init', '-b', 'main')
  await git('config', 'user.name', 'Event Test')
  await git('config', 'user.email', 'event@example.test')
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await removeTemp(cwd)
})

/** The extension's bash tool, run as one call of conversation 7 in `dir`. */
async function bash(command: string, dir = cwd) {
  const extension = codingTools({
    emit: async (_tx, event, data) => {
      expect(event).toBe(Committed)
      emitted.push(data as Event)
      return undefined as never
    },
  })
  const tool = extension.tools!.find((candidate) => candidate.name === 'bash') as ReturnType<
    typeof createBashTool
  >
  let output = ''
  const api = {
    conversationId: 7 as ConversationId,
    taskId: 'task-commit-events',
    callId: 'call',
    env: new NodeExecutionEnv({ cwd: dir }),
    output: (chunk: string | Uint8Array) => (output += chunk.toString()),
    outputWindow: undefined,
    retainedOutput: () => ({ text: output, truncated: false }),
    diagnostic: () => {},
    // These calls exercise commit recording without user cancellation.
    snapshot: async () => ({ calls: {} }),
    watchDoc: async () => ({
      value: { calls: {} },
      start: () => {},
      stop: async () => {},
    }),
    commit: async (change: (tx: never) => unknown) => change(undefined as never),
  } as unknown as ToolExecutionApi
  const result = await tool.execute({ command }, api, context)
  return { result, output }
}

it('records a commit through bash with its full sha, parents, branch and subject', async () => {
  await bash('git commit -q --allow-empty -m first && git commit -q --allow-empty -m second')
  const [first, second] = [await git('rev-parse', 'HEAD~1'), await git('rev-parse', 'HEAD')]
  expect(emitted).toEqual([
    { conversation: 7, sha: first, parents: [], repo: cwd, branch: 'main', subject: 'first' },
    {
      conversation: 7,
      sha: second,
      parents: [first],
      repo: cwd,
      branch: 'main',
      subject: 'second',
    },
  ])
  expect(second).toMatch(/^[0-9a-f]{40}$/)
})

it('records an amend with the commit it replaced', async () => {
  await git('commit', '--allow-empty', '-m', 'one')
  const before = await git('rev-parse', 'HEAD')
  await bash('git commit -q --amend --allow-empty -m two')
  expect(emitted).toEqual([
    {
      conversation: 7,
      sha: await git('rev-parse', 'HEAD'),
      parents: [],
      repo: cwd,
      branch: 'main',
      subject: 'two',
      rewrittenFrom: before,
    },
  ])
})

it('records a commit in a linked worktree under its repository and a detached HEAD without branch', async () => {
  await git('commit', '--allow-empty', '-m', 'base')
  const tree = join(cwd, 'tree')
  await git('worktree', 'add', '--detach', tree)
  await bash('git commit -q --allow-empty -m detached', tree)
  expect(emitted).toEqual([
    expect.objectContaining({ repo: cwd, worktree: tree, subject: 'detached' }),
  ])
  expect(emitted[0]).not.toHaveProperty('branch')
})

it('records its own merge commits but not fast-forwards', async () => {
  await git('commit', '--allow-empty', '-m', 'base')
  await git('checkout', '-b', 'side')
  await git('commit', '--allow-empty', '-m', 'side')
  await git('checkout', 'main')
  await git('checkout', '-b', 'ff', 'main')
  await bash('git merge -q --ff-only side')
  expect(emitted).toEqual([])
  await git('checkout', 'main')
  await git('commit', '--allow-empty', '-m', 'main')
  await bash('git merge -q --no-ff side -m merged')
  expect(emitted).toEqual([
    expect.objectContaining({ sha: await git('rev-parse', 'HEAD'), subject: 'merged' }),
  ])
  expect(emitted[0].parents).toHaveLength(2)
})

it('keeps concurrent calls of the same task apart', async () => {
  const other = await realpath(await temp('ultimate-commit-events-other-'))
  try {
    await run('git', ['init', '-q', '-b', 'main'], { cwd: other })
    const commit = 'git -c user.name=t -c user.email=t@t commit -q --allow-empty -m'
    await Promise.all([bash(`${commit} here`), bash(`${commit} there`, other)])
    expect(emitted).toHaveLength(2)
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repo: cwd, subject: 'here' }),
        expect.objectContaining({ repo: other, subject: 'there' }),
      ]),
    )
  } finally {
    await removeTemp(other)
  }
})

it('records the commits an apply-backend rebase rewrote, however old their dates', async () => {
  await git('commit', '--allow-empty', '-m', 'base')
  await git('checkout', '-b', 'side')
  await run('bash', ['-c', 'echo s > s && git add s && git commit -qm side'], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z' },
  })
  const old = await git('rev-parse', 'HEAD')
  await git('checkout', 'main')
  await run('bash', ['-c', 'echo m > m && git add m && git commit -qm main'], { cwd })
  await git('checkout', 'side')
  await bash('git rebase -q --apply --committer-date-is-author-date main')
  expect(emitted).toEqual([
    expect.objectContaining({
      sha: await git('rev-parse', 'HEAD'),
      subject: 'side',
      rewrittenFrom: old,
    }),
  ])
})

it('records each commit of a rebase once, in the call that made it, without a branch', async () => {
  await git('commit', '--allow-empty', '-m', 'base')
  await git('checkout', '-b', 'side')
  await run('bash', ['-c', 'echo a > a && git add a && git commit -qm one'], { cwd })
  await run('bash', ['-c', 'echo side > f && git add f && git commit -qm two'], { cwd })
  const two = await git('rev-parse', 'HEAD')
  await git('checkout', 'main')
  await run('bash', ['-c', 'echo main > f && git add f && git commit -qm main'], { cwd })
  await git('checkout', 'side')
  // `one` applies, `two` conflicts: the call stops mid-rebase.
  await bash('git rebase -q main').catch(() => undefined)
  const first = await git('rev-parse', 'HEAD')
  expect(emitted).toEqual([
    {
      conversation: 7,
      sha: first,
      parents: [await git('rev-parse', 'main')],
      repo: cwd,
      subject: 'one',
    },
  ])
  await bash('echo both > f && git add f && GIT_EDITOR=true git rebase --continue')
  expect(emitted.slice(1)).toEqual([
    {
      conversation: 7,
      sha: await git('rev-parse', 'HEAD'),
      parents: [first],
      repo: cwd,
      subject: 'two',
      rewrittenFrom: two,
    },
  ])
})

it('keeps a commit when a squash merge in the same call leaves HEAD on it', async () => {
  await git('commit', '--allow-empty', '-m', 'base')
  await git('checkout', '-b', 'side')
  await run('bash', ['-c', 'echo s > s && git add s && git commit -qm side'], { cwd })
  await git('checkout', 'main')
  await bash('git commit -q --allow-empty -m mine && git merge -q --squash side')
  expect(emitted).toEqual([expect.objectContaining({ subject: 'mine' })])
})

it('records no merge when it fast-forwards onto an earlier merge of its own', async () => {
  await git('commit', '--allow-empty', '-m', 'base')
  await git('checkout', '-b', 'side')
  await git('commit', '--allow-empty', '-m', 'side')
  await git('checkout', 'main')
  await git('commit', '--allow-empty', '-m', 'main')
  await bash('git merge -q --no-ff side -m merged')
  expect(emitted).toHaveLength(1)
  await git('checkout', '-b', 'later', 'main~1')
  await bash('git merge -q --ff-only main')
  expect(emitted).toHaveLength(1)
})

it('records a merge of a branch whose name says Fast-forward', async () => {
  await git('commit', '--allow-empty', '-m', 'base')
  await git('checkout', '-b', 'Fast-forward')
  await git('commit', '--allow-empty', '-m', 'side')
  await git('checkout', 'main')
  await git('commit', '--allow-empty', '-m', 'main')
  await bash('git merge -q --no-ff Fast-forward')
  expect(emitted).toEqual([expect.objectContaining({ sha: await git('rev-parse', 'HEAD') })])
})

it('records nothing when bash made no commit', async () => {
  await bash('git status --short && echo done')
  await bash('false').catch(() => undefined)
  expect(emitted).toEqual([])
})

it('never fails a commit when the log cannot be written', async () => {
  // A log path inside a missing directory makes every hook's append fail.
  vi.stubEnv('TMPDIR', join(cwd, 'missing'))
  const { result } = await bash('git commit -q --allow-empty -m kept && echo ok')
  expect(result.isError).toBeFalsy()
  expect(await git('log', '-1', '--format=%s')).toBe('kept')
  expect(emitted).toEqual([])
})
