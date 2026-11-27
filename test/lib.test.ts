import { lstat, mkdir, readdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { expect, it } from 'vitest'
import { agentDefinitions } from '../lib/agents.ts'
import { git, isolatable, noCommit, noRepository } from '../lib/git.ts'
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

it('reports a looping agent symlink as one error and keeps discovering the rest', async () => {
  const root = await temp('ultimate-lib-')
  await mkdir(join(root, 'agents'))
  await writeFile(
    join(root, 'agents/good.md'),
    '---\nname: good\ndescription: Good helper\n---\nDo the work.\n',
  )
  await symlink('loop.md', join(root, 'agents/loop.md'))
  const resources = new Map<string, unknown>()
  const discovery = await agentDefinitions({
    ultimateRoot: root,
    projectRoot: root,
    userHome: root,
    modelRuntime: await ModelRuntime.create(),
    resource: <T>(key: string, create: () => T) =>
      (resources.get(key) ?? resources.set(key, create()).get(key)) as T,
  })
  expect(discovery.definitions.map((definition) => definition.name)).toEqual(['good'])
  expect(discovery.errors).toMatchObject([
    { name: 'loop', path: join(root, 'agents/loop.md'), error: expect.stringContaining('ELOOP') },
  ])
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
    /Command failed: git rev-parse --show-toplevel\n.*not a git repository/,
  )
  expect(await isolatable(dir)).toEqual({ reason: noRepository })
  const repo = join(dir, 'repo')
  await mkdir(repo)
  await git(repo, 'init', '-q', '-b', 'main')
  expect(await isolatable(repo)).toEqual({ reason: noCommit })
  expect(await git({ cwd: repo, timeout: 0 }, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
})
