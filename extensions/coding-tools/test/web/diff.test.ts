import { createPatch } from 'diff'
import { expect, it } from 'vitest'
import { parsePatch } from '../../diff.web.ts'

it('keeps a removed Markdown rule and an added ++ line, which look like file headers inside a hunk', () => {
  const rows = parsePatch(
    createPatch('section', 'a\n---\nb\n', 'a\n++x\nb\n', '', '', { context: 3 }),
  )
  expect(rows.filter((row) => row.type !== 'hunk')).toEqual([
    { type: 'context', text: 'a', old: 1, new: 1 },
    { type: 'del', text: '---', old: 2 },
    { type: 'add', text: '++x', new: 2 },
    { type: 'context', text: 'b', old: 3, new: 3 },
  ])
})
