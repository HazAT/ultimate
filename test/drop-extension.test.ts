import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import {
  attachmentPath,
  dropRoots,
  findFiles,
  safeName,
  saveFile,
} from '../.ultimate/extensions/drop/files.ts'

const made: string[] = []

function tree(paths: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'drop-'))
  made.push(root)
  for (const path of paths) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), path)
  }
  return root
}

afterEach(async () => {
  await Promise.all(made.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('finds a dropped file by name and nothing that only looks like it', async () => {
  const root = tree([
    'app.ts',
    'sub/app.ts',
    'node_modules/pkg/app.ts',
    'dist/app.ts',
    '.git/app.ts',
    '.hidden/app.ts',
    'deep/a/b/c/d/app.ts',
  ])
  const found = await findFiles([root], 'app.ts', { depth: 3 })
  expect(found).toEqual([join(root, 'app.ts'), join(root, 'sub/app.ts')])
})

it('stops at its match cap instead of listing the whole disk', async () => {
  const root = tree(['a/x.ts', 'b/x.ts', 'c/x.ts'])
  expect(await findFiles([root], 'x.ts', { matches: 2 })).toEqual([
    join(root, 'a/x.ts'),
    join(root, 'b/x.ts'),
  ])
})

it('searches several roots in order and skips one that is not there', async () => {
  const first = tree(['x.ts'])
  const second = tree(['inner/x.ts'])
  const found = await findFiles([join(first, 'missing'), first, second], 'x.ts')
  expect(found).toEqual([join(first, 'x.ts'), join(second, 'inner/x.ts')])
})

it('lists the folders a dropped file is looked for in, the configured ones last', () => {
  expect(
    dropRoots({ userHome: '/home/u', home: '/state', projectRoot: '/work/p' }, ['/elsewhere']),
  ).toEqual([
    '/home/u/Desktop',
    '/home/u/Downloads',
    '/home/u/Documents',
    '/state/worktrees',
    '/work/p',
    '/elsewhere',
  ])
})

it('turns whatever a drop is called into one file name', () => {
  expect(safeName('../../etc/passwd')).toBe('..-..-etc-passwd')
  expect(safeName('/etc/passwd')).toBe('-etc-passwd')
  expect(safeName('a\u0000b.txt')).toBe('ab.txt')
  expect(safeName('..')).toBe('dropped-file')
  expect(safeName('')).toBe('dropped-file')
  expect(safeName('x'.repeat(200))).toHaveLength(120)
  // Whatever it is called, the file lands in the folder it was given.
  expect(attachmentPath('/state/attachments/7', '../../../etc/passwd')).toBe(
    '/state/attachments/7/..-..-..-etc-passwd',
  )
})

it('saves a dropped file in the conversation folder, numbering a name already there', async () => {
  const directory = join(tree([]), 'attachments', '7')
  const first = await saveFile(directory, 'notes.txt', new Uint8Array([1, 2]))
  const second = await saveFile(directory, 'notes.txt', new Uint8Array([3]))
  expect(first).toBe(join(directory, 'notes.txt'))
  expect(second).toBe(join(directory, 'notes-2.txt'))
})
