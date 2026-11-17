import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { addCheckout, removeCheckout, treeName, treePath } from '../../tree.ts'

const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
function repository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tree-')))
  const source = join(root, 'source')
  execFileSync('git', ['init', '-q', '-b', 'main', source])
  run(
    source,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'first',
  )
  return { root, source, base: run(source, 'rev-parse', 'HEAD') }
}

test('a configured path names checkouts, expands ~, resolves symlinks and must be absolute', async () => {
  expect(treeName('ultimate/abc123-7')).toBe('ult-abc123-7')
  expect(await treePath({ isolates: { worktree: { path: '~/trees/{name}/src' } } }, 'ult-1')).toBe(
    join(realpathSync(homedir()), 'trees/ult-1/src'),
  )
  expect(await treePath({}, 'ult-1')).toBeUndefined()
  const { root } = repository()
  symlinkSync(root, join(root, 'link'))
  expect(await treePath({ isolates: { worktree: { path: join(root, 'link/{name}') } } }, 'a')).toBe(
    join(root, 'a'),
  )
  await expect(treePath({ isolates: { worktree: { path: 'trees/{name}' } } }, 'a')).rejects.toThrow(
    'must be absolute',
  )
  await expect(
    treePath({ isolates: { worktree: { path: join(root, 'code') } } }, 'a'),
  ).rejects.toThrow('must contain {name}')
  await expect(treePath({ isolates: { worktree: { path: 1 } } }, 'a')).rejects.toThrow(
    'isolates.worktree.path must be a string',
  )
})

test('a path alone keeps git worktree add and remove', async () => {
  const { root, source, base } = repository()
  const settings = { isolates: { worktree: { path: join(root, 'trees/{name}') } } }
  const path = (await treePath(settings, 'ult-1'))!
  await addCheckout(settings, source, path, 'ult-1', ['-b', 'ultimate/x-1', base])
  expect(run(path, 'symbolic-ref', '--short', 'HEAD')).toBe('ultimate/x-1')
  await removeCheckout(settings, source, path, 'ult-1')
  expect(run(source, 'worktree', 'list', '--porcelain')).not.toContain(path)
})

test('configured add and remove commands get {name} and {path} as shell words, and must do their part', async () => {
  const { root, source, base } = repository()
  const settings = {
    isolates: {
      worktree: {
        path: join(root, "it's here/{name}"),
        add: 'git worktree add --detach {path} HEAD',
        remove: 'git worktree remove {path}',
      },
    },
  }
  const path = (await treePath(settings, 'ult-2'))!
  await addCheckout(settings, source, path, 'ult-2', ['-b', 'ultimate/x-2', base])
  expect(run(path, 'symbolic-ref', '--short', 'HEAD')).toBe('ultimate/x-2')
  await expect(
    removeCheckout({ isolates: { worktree: { remove: 'true' } } }, source, path, 'ult-2'),
  ).rejects.toThrow('isolates.worktree.remove left')
  await removeCheckout(settings, source, path, 'ult-2')
  expect(run(source, 'worktree', 'list', '--porcelain')).not.toContain(path)
  await expect(
    addCheckout({ isolates: { worktree: { add: 'exit 3' } } }, source, join(root, 'n'), 'n', [
      '--detach',
      base,
    ]),
  ).rejects.toThrow('isolates.worktree.add failed')
  await expect(
    addCheckout({ isolates: { worktree: { add: 'true' } } }, source, join(root, 'm'), 'm', [
      '--detach',
      base,
    ]),
  ).rejects.toThrow('isolates.worktree.add left no worktree')
})

test('a failed add clears its half-made checkout, so the command can run again', async () => {
  const { root, source, base } = repository()
  const path = join(root, 'half')
  // The command registers the worktree and then fails, as an interrupted copy would.
  const settings = {
    isolates: { worktree: { add: 'git worktree add --detach {path} HEAD && exit 4' } },
  }
  await expect(
    addCheckout(settings, source, path, 'half', ['-b', 'ultimate/x-3', base]),
  ).rejects.toThrow('isolates.worktree.add failed')
  expect(existsSync(path)).toBe(false)
  expect(run(source, 'worktree', 'list', '--porcelain')).not.toContain(path)
  const fixed = { isolates: { worktree: { add: 'git worktree add --detach {path} HEAD' } } }
  await addCheckout(fixed, source, path, 'half', ['-b', 'ultimate/x-3', base])
  expect(run(path, 'symbolic-ref', '--short', 'HEAD')).toBe('ultimate/x-3')
})

test('the remove command never runs on a checkout with modified or untracked files', async () => {
  const { root, source, base } = repository()
  const log = join(root, 'removed')
  const settings = {
    isolates: {
      worktree: {
        path: join(root, '{name}'),
        remove: `echo ran > '${log}' && git worktree remove --force {path}`,
      },
    },
  }
  const path = (await treePath(settings, 'ult-4'))!
  await addCheckout(settings, source, path, 'ult-4', ['-b', 'ultimate/x-4', base])
  writeFileSync(join(path, 'work.txt'), 'unsaved')
  await expect(removeCheckout(settings, source, path, 'ult-4')).rejects.toThrow(
    'contains modified or untracked files',
  )
  expect(existsSync(log)).toBe(false)
  expect(existsSync(join(path, 'work.txt'))).toBe(true)
})
