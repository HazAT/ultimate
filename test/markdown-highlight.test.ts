import { expect, it } from 'vitest'
import { highlight } from '../web/src/components/markdown/highlight.ts'
import type { Line } from '../web/src/components/markdown/highlight.ts'

const highlighted = (code: string, name: string): Promise<Line[]> =>
  new Promise((resolve) => {
    const lines = highlight(code, name, resolve)
    if (lines !== undefined) resolve(lines)
  })

it('finishes highlighting one-line struct fields whose repeated qualified types hang a backtracking regex engine', async () => {
  // Shiki's JavaScript regex engine never returns from three or more qualified
  // types in one-line struct fields; the Oniguruma engine tokenizes them in
  // milliseconds. Completing within the test timeout is the regression.
  const lines = await highlighted('type S struct { A uuid.UUID; B uuid.UUID; C uuid.UUID', 'go')
  expect(lines.length).toBe(1)
  expect(lines[0].length).toBeGreaterThan(1)
})

it('still highlights a normal code block into themed tokens', async () => {
  const lines = await highlighted('const answer = 42', 'ts')
  expect(lines.length).toBe(1)
  expect(lines[0].length).toBeGreaterThan(1)
})
