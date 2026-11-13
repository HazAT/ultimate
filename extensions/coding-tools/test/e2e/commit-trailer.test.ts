import { execFile } from 'node:child_process'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import type { ConversationId } from '@earendil-works/pi-durable'
import { type BashExecution } from '@earendil-works/pi-durable/tools'
import { prepareBash } from '../../server.ts'
import { removeTemp, temp } from '../../../../test/helpers.ts'

const run = promisify(execFile)

it.each([0, 1])(
  'links tool commits without affecting outside commits (existing config count %i)',
  async (count) => {
    const cwd = await temp('ultimate-commit-trailer-')
    vi.stubEnv('GIT_CONFIG_COUNT', String(count))
    if (count) {
      vi.stubEnv('GIT_CONFIG_KEY_0', 'ultimate.test')
      vi.stubEnv('GIT_CONFIG_VALUE_0', 'preserved')
    }
    const git = (...args: string[]) => run('git', args, { cwd })
    try {
      await git('init', '-b', 'main')
      await git('config', 'user.name', 'Trailer Test')
      await git('config', 'user.email', 'trailer@example.test')
      const hooks = join(cwd, '.git', 'hooks')
      const before = await readdir(hooks)
      const execution: BashExecution = { command: '', cwd, env: {}, inheritEnv: true }
      await prepareBash(execution, { conversationId: 34820 as ConversationId })
      const bash = (command: string) =>
        run('bash', ['-c', command], { cwd, env: { ...process.env, ...execution.env } })
      expect((await bash('git config --list')).stdout.includes('ultimate.test=preserved')).toBe(
        count === 1,
      )
      await bash(
        'git init fixture && git -C fixture -c user.name=Test -c user.email=test@example.test commit --allow-empty -m fixture',
      )
      expect((await bash('git -C fixture log -1 --format=%B')).stdout).toBe('fixture\n\n')
      await bash('git commit --allow-empty -m x -m "Other-Trailer: kept"')
      expect((await git('log', '-1', '--format=%B')).stdout).toContain(
        'Ultimate-Conversation: 34820',
      )
      expect((await git('log', '-1', '--format=%B')).stdout).toContain('Other-Trailer: kept')

      await prepareBash(execution, { conversationId: 42 as ConversationId })
      await run('bash', ['-c', 'git commit --amend --allow-empty --no-edit'], {
        cwd,
        env: { ...process.env, ...execution.env },
      })
      const amended = (await git('log', '-1', '--format=%B')).stdout
      expect(amended).toContain('Ultimate-Conversation: 34820')
      expect(amended).not.toContain('Ultimate-Conversation: 42')
      expect(amended).toContain('Other-Trailer: kept')

      await bash('git commit --allow-empty -m fresh')
      expect((await git('log', '-1', '--format=%B')).stdout).toBe(
        'fresh\n\nUltimate-Conversation: 42\n\n',
      )

      await git('checkout', '-b', 'branch')
      await git('commit', '--allow-empty', '-m', 'outside')
      expect((await git('log', '-1', '--format=%B')).stdout).not.toContain('Ultimate-Conversation:')
      await git('checkout', 'main')
      await bash('git merge --no-ff branch -m merge')
      expect((await git('log', '-1', '--format=%B')).stdout).toContain('Ultimate-Conversation: 42')
      expect(await readdir(hooks)).toEqual(before)
      expect((await git('config', '--local', '--list')).stdout).not.toContain('hook.ultimate.')
    } finally {
      vi.unstubAllEnvs()
      await removeTemp(cwd)
    }
  },
)

it('preserves original attribution when another conversation rebases a commit', async () => {
  const cwd = await temp('ultimate-commit-trailer-')
  vi.stubEnv('GIT_CONFIG_COUNT', '0')
  const git = (...args: string[]) => run('git', args, { cwd })
  try {
    await git('init', '-b', 'main')
    await git('config', 'user.name', 'Trailer Test')
    await git('config', 'user.email', 'trailer@example.test')
    await git('commit', '--allow-empty', '-m', 'base')
    await git('checkout', '-b', 'topic')
    await writeFile(join(cwd, 'topic.txt'), 'topic\n')
    await git('add', 'topic.txt')
    const execution: BashExecution = { command: '', cwd, env: {}, inheritEnv: true }
    await prepareBash(execution, { conversationId: 34820 as ConversationId })
    const bash = (command: string) =>
      run('bash', ['-c', command], { cwd, env: { ...process.env, ...execution.env } })
    await bash('git commit -m topic -m "Other-Trailer: kept"')
    const original = (await git('log', '-1', '--format=%B')).stdout
    const before = (await git('rev-parse', 'HEAD')).stdout
    await git('checkout', 'main')
    await git('commit', '--allow-empty', '-m', 'advance')
    await git('checkout', 'topic')

    await prepareBash(execution, { conversationId: 42 as ConversationId })
    await bash('git rebase main')

    expect((await git('rev-parse', 'HEAD')).stdout).not.toBe(before)
    expect((await git('rev-parse', 'HEAD^')).stdout).toBe((await git('rev-parse', 'main')).stdout)
    expect((await git('log', '-1', '--format=%B')).stdout).toBe(original)
    expect(original).toContain('Ultimate-Conversation: 34820')
    expect(original).toContain('Other-Trailer: kept')
  } finally {
    vi.unstubAllEnvs()
    await removeTemp(cwd)
  }
})
