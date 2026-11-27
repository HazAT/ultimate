/**
 * `model/` is what runs in the browser and in Node alike, so nothing in it may reach outside it: every import there
 * is a sibling module of `model/`, never a package, a `node:` builtin, `@/` or `../`. AGENTS.md rule 2.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const MODEL = join(import.meta.dirname, '..', 'model')

/** Every module a file imports or re-exports: `from '…'`, `import '…'` and `import('…')` or `import(`…`)`, never a quoted word. */
const SPECIFIER =
  /(?<!['"`\w])(?:(?:from|import)\s*['"]([^'"]+)['"]|import\s*\(\s*['"`]([^'"`]+)['"`])/g

it('model/ imports nothing but its own files', async () => {
  const entries = await readdir(MODEL)
  // Only flat .ts modules: a folder or another kind of file would escape the check below.
  expect(
    entries.filter((name) => !name.endsWith('.ts')),
    'model/ holds only .ts modules',
  ).toStrictEqual([])
  const files = entries.filter((name) => name.endsWith('.ts'))
  expect(files.length, `found ${files.length} modules in model/`).toBeGreaterThan(5)
  const outside: string[] = []
  for (const file of files) {
    const text = await readFile(join(MODEL, file), 'utf8')
    for (const [, quoted, dynamic] of text.matchAll(SPECIFIER)) {
      const specifier = quoted ?? dynamic
      const sibling = specifier.startsWith('./') ? specifier.slice(2) : undefined
      if (sibling === undefined || sibling.includes('/') || !files.includes(sibling))
        outside.push(`${file} imports ${specifier}`)
    }
  }
  expect(outside, 'model/ must import only its own modules').toStrictEqual([])
})
