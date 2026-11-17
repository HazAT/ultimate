import {
  access,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { git, gitArgs, isolatable, noCommit, noRepository } from '../lib/git.ts'
import { spawn } from '../lib/spawn.ts'
import { readJson, updateJson, writeJson } from '../lib/json-file.ts'
import { readSettings, updateSettings } from '../lib/settings.ts'
import { shortTitle } from '../lib/title.ts'
import { temp } from './helpers.ts'

it('titles a long Markdown prompt by its first meaningful line, cut short', () => {
  const prompt = `## Goal\nDesign a redesign of @ultimate's conversation view (the "chat" mode of the transcript) so it reads as one conversation.\n\n${'More detail. '.repeat(500)}`
  const title = shortTitle(prompt)
  expect(title).toBe('Design a redesign of @ultimate\'s conversation view (the "ch…')
  expect(title.length).toBeLessThanOrEqual(60)
  expect(shortTitle('**Task:** find the callers')).toBe('Task: find the callers')
  expect(shortTitle('fork task')).toBe('fork task')
})

it('reads a missing JSON file as the fallback and rejects unreadable JSON', async () => {
  const dir = await temp('ultimate-lib-')
  expect(await readJson(join(dir, 'missing.json'), { ports: {} })).toEqual({ ports: {} })
  await writeFile(join(dir, 'broken.json'), '{')
  await expect(readJson(join(dir, 'broken.json'), {})).rejects.toThrow(SyntaxError)
})

it('writes two-space JSON with a trailing newline into new folders and leaves no temporary file', async () => {
  const dir = await temp('ultimate-lib-')
  const path = join(dir, 'nested/settings.json')
  await writeJson(path, { a: 1 })
  await writeJson(path, { b: [true] })
  expect(await readFile(path, 'utf8')).toBe('{\n  "b": [\n    true\n  ]\n}\n')
  expect(await readdir(join(dir, 'nested'))).toEqual(['settings.json'])
})

it('writes through a symlinked file to its target and keeps the link', async () => {
  const dir = await temp('ultimate-lib-')
  await mkdir(join(dir, 'repo'))
  await writeFile(join(dir, 'repo/settings.json'), '{}\n')
  await symlink('repo/settings.json', join(dir, 'settings.json'))
  await writeJson(join(dir, 'settings.json'), { a: 1 })
  expect((await lstat(join(dir, 'settings.json'))).isSymbolicLink()).toBe(true)
  expect(await readlink(join(dir, 'settings.json'))).toBe('repo/settings.json')
  expect(await readFile(join(dir, 'repo/settings.json'), 'utf8')).toBe('{\n  "a": 1\n}\n')
  expect(await readdir(join(dir, 'repo'))).toEqual(['settings.json'])
})

const readCounter = (file: string) => readJson<{ count: number }>(file, { count: 0 })

it('serialises concurrent updates of one file, and a failed update does not block later ones', async () => {
  const dir = await temp('ultimate-lib-')
  const path = join(dir, 'counter.json')
  const increment = () =>
    updateJson(path, readCounter, (value) => {
      value.count++
    })
  const failing = updateJson(path, readCounter, () => {
    throw new Error('refused')
  })
  await Promise.all([
    ...Array.from({ length: 10 }, increment),
    expect(failing).rejects.toThrow('refused'),
    ...Array.from({ length: 10 }, increment),
  ])
  expect(await readCounter(path)).toEqual({ count: 20 })
})

it('keeps other settings keys and refuses a settings file that is not an object', async () => {
  const dir = await temp('ultimate-lib-')
  const path = join(dir, 'settings.json')
  expect(await readSettings(path)).toEqual({})
  await writeJson(path, { keep: 'me' })
  await updateSettings(path, (value) => {
    value.added = true
  })
  expect(await readSettings(path)).toEqual({ keep: 'me', added: true })
  await writeFile(path, '[]')
  await expect(readSettings(path)).rejects.toThrow('Settings must be a JSON object')
  await expect(updateSettings(path, () => {})).rejects.toThrow('Settings must be a JSON object')
})

it('trims git output, reports a failed command with its stderr and explains why a folder is not isolatable', async () => {
  const dir = await temp('ultimate-lib-')
  await expect(git(dir, 'rev-parse', '--show-toplevel')).rejects.toThrow(
    /rev-parse --show-toplevel\n.*not a git repository/,
  )
  expect(await isolatable(dir)).toEqual({ reason: noRepository })
  const repo = join(dir, 'repo')
  await mkdir(repo)
  await git(repo, 'init', '-q', '-b', 'main')
  expect(await isolatable(repo)).toEqual({ reason: noCommit })
  expect(await git({ cwd: repo, timeout: 0 }, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
})

async function hardeningRepo(dir: string) {
  const repo = join(dir, 'repo')
  await mkdir(repo)
  await git(repo, 'init', '-q', '-b', 'main')
  await git(repo, 'config', 'user.email', 't@example.com')
  await git(repo, 'config', 'user.name', 'T')
  await writeFile(join(repo, 'f.txt'), 'base')
  await git(repo, 'add', 'f.txt')
  await git(repo, 'commit', '-m', 'init')
  return repo
}

it('does not run a repo fsmonitor command on git status', async () => {
  const dir = await temp('ultimate-lib-')
  const repo = await hardeningRepo(dir)
  const marker = join(dir, 'fsmonitor')
  await git(repo, 'config', 'core.fsmonitor', `touch ${marker}`)
  await git(repo, 'status', '--porcelain')
  await expect(access(marker)).rejects.toThrow('ENOENT')
})

it('does not run a repo smudge filter command on checkout', async () => {
  const dir = await temp('ultimate-lib-')
  const repo = await hardeningRepo(dir)
  const marker = join(dir, 'smudge')
  await git(repo, 'config', 'filter.evil.smudge', `touch ${marker}`)
  await writeFile(join(repo, '.gitattributes'), '*.bin filter=evil\n')
  await writeFile(join(repo, 'x.bin'), 'ABC')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-m', 'attributes')
  await writeFile(join(repo, 'x.bin'), 'changed')
  await git(repo, 'checkout', '--', 'x.bin')
  await expect(access(marker)).rejects.toThrow('ENOENT')
})

it('does not run a repo clean filter command on git status', async () => {
  const dir = await temp('ultimate-lib-')
  const repo = await hardeningRepo(dir)
  const marker = join(dir, 'clean')
  await git(repo, 'config', 'filter.evil.clean', `touch ${marker}; cat`)
  await writeFile(join(repo, '.gitattributes'), '*.bin filter=evil\n')
  await writeFile(join(repo, 'x.bin'), 'ABC')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-m', 'attributes')
  await git(repo, 'status', '--porcelain')
  await expect(access(marker)).rejects.toThrow('ENOENT')
})

function gitWithStdin(argv: string[], cwd: string, stdin: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', argv, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    let output = ''
    child.stdout?.on('data', (chunk) => (output += chunk))
    child.stderr?.on('data', (chunk) => (output += chunk))
    child.on('error', reject)
    child.on('close', () => resolve(output))
    child.stdin?.write(stdin)
    child.stdin?.end()
  })
}

it('fetches over ssh with no global ssh command, never running a repo-local one', async () => {
  const dir = await temp('ultimate-lib-')
  const repo = await hardeningRepo(dir)
  const bin = join(dir, 'bin')
  const reached = join(dir, 'ssh-reached')
  const pwned = join(dir, 'pwned')
  await mkdir(bin)
  await writeFile(join(bin, 'ssh'), `#!/bin/sh\ntouch ${reached}\nexit 1\n`, { mode: 0o755 })
  const global = join(dir, 'gitconfig')
  await writeFile(global, '')
  await git(repo, 'remote', 'add', 'origin', 'git@example.com:owner/repo.git')
  await git(repo, 'config', 'core.sshCommand', `touch ${pwned}`)
  vi.stubEnv('GIT_CONFIG_GLOBAL', global)
  vi.stubEnv('GIT_SSH', undefined)
  vi.stubEnv('GIT_SSH_COMMAND', undefined)
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  try {
    await expect(git(repo, 'fetch', 'origin')).rejects.toThrow(
      'Could not read from remote repository',
    )
    await access(reached)
    await expect(access(pwned)).rejects.toThrow('ENOENT')
  } finally {
    vi.unstubAllEnvs()
  }
})

it('keeps the global ssh command and credential helper over a repo-local value', async () => {
  const dir = await temp('ultimate-lib-')
  const repo = await hardeningRepo(dir)
  const marker = join(dir, 'credential-helper')
  const global = join(dir, 'gitconfig')
  await writeFile(
    global,
    [
      '[core]',
      '  sshCommand = ssh -i /tmp/trusted-key',
      '[credential]',
      '  helper = !echo trusted',
      '',
    ].join('\n'),
  )
  process.env.GIT_CONFIG_GLOBAL = global
  try {
    await git(repo, 'config', 'core.sshCommand', 'touch /tmp/pwned')
    await git(repo, 'config', 'credential.helper', `!touch ${marker}`)
    await git(repo, 'config', 'credential.https://github.com.helper', `!touch ${marker}`)
    expect(await git(repo, 'config', '--get', 'core.sshCommand')).toBe('ssh -i /tmp/trusted-key')
    const fill = await gitWithStdin(
      await gitArgs(repo, ['credential', 'fill']),
      repo,
      'protocol=https\nhost=github.com\n\n',
    )
    expect(fill).toContain('trusted')
    await expect(access(marker)).rejects.toThrow('ENOENT')
  } finally {
    delete process.env.GIT_CONFIG_GLOBAL
  }
})
