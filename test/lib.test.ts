import { lstat, mkdir, readdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { git, isolatable, noCommit, noRepository } from '../lib/git.ts'
import { readJson, updateJson, writeJson } from '../lib/json-file.ts'
import { redactSecrets } from '../lib/redact.ts'
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

it('masks token-shaped text and keeps ordinary error text readable', () => {
  const fake = [
    'Bearer eyJhbGciOi.payload.sig',
    'password: hunter2',
    '"apiKey": "abc123"',
    'token=abc',
    'sk-proj-0123456789ab',
    'ghp_0123456789abcdefABCDEF',
    'xoxb-1234-5678-abcdef',
    'AKIAABCDEFGHIJKLMNOP',
    'deadbeef0123456789abcdef01234567',
    'dGhpcyBpcyBhIHNlY3JldCB2YWx1ZQ1==',
    'passphrase: opensesame',
    'Set-Cookie: sid=abc',
  ]
  for (const secret of fake) expect(redactSecrets(`failed: ${secret} end`)).toContain('[redacted]')
  expect(redactSecrets('Error: x token=abc123 y')).toBe('Error: x token=[redacted] y')
  expect(redactSecrets('password="correct horse, battery" next')).toBe('password=[redacted] next')
  expect(redactSecrets("secret: 'a\\'b c' next")).toBe('secret: [redacted] next')
  expect(redactSecrets('pwd=a;b&c next')).toBe('pwd=[redacted] next')
  expect(redactSecrets('cut at ghp_abcdefgh')).toBe('cut at [redacted]')
  expect(redactSecrets('url: token=abc key: Bearer x')).toBe(
    'url: token=[redacted] key: Bearer [redacted]',
  )
  expect(redactSecrets('jwt eyJhbGciOi.eyJzdWIi.c2ln end')).toBe('jwt [redacted] end')
  expect(redactSecrets('clone https://bot:hunter2@host.example/a/b failed')).toBe(
    'clone https://bot:[redacted]@host.example/a/b failed',
  )
  expect(redactSecrets('Authorization: token abc123def end')).toBe('Authorization: [redacted] end')
  expect(redactSecrets('x-api-key: abcd1234 end')).toBe('x-api-key: [redacted] end')
  expect(
    redactSecrets(
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7bq\n-----END RSA PRIVATE KEY-----',
    ),
  ).toBe('[redacted]')
  expect(redactSecrets('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNz cut')).toBe('[redacted]')
  const labels = 'author: james; keyboard: us; tokenizer: bpe; Unexpected token } in JSON'
  expect(redactSecrets(labels)).toBe(labels)
  const started = performance.now()
  for (const hostile of ['eyJa-', 'key="a ', 'x"', '://a:b']) redactSecrets(hostile.repeat(80_000))
  expect(performance.now() - started).toBeLessThan(2000)
  const plain =
    'TimeoutError: locator.waitFor: selector timed out after 60s at /Users/james/src/my-project-2026-backup-directory/file.ts:120 (2026-11-18T20:21:23.000Z) uuid 123e4567-e89b-12d3-a456-426614174000'
  expect(redactSecrets(plain)).toBe(plain)
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
