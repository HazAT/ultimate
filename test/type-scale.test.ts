import { readFileSync, readdirSync } from 'node:fs'
import { expect, it } from 'vitest'

const sources = (dir: string) =>
  readdirSync(new URL(`../${dir}`, import.meta.url), { recursive: true })
    .map(String)
    .filter((path) => path.endsWith('.tsx') || path.endsWith('.ts') || path.endsWith('.css'))
    .map(
      (path) =>
        [path, readFileSync(new URL(`../${dir}/${path}`, import.meta.url), 'utf8')] as const,
    )

it('never sizes text in fixed pixels', () => {
  // A px size ignores the browser's font-size setting: the UI stays the same size for a user who raised it.
  // `rem` follows the root, which is what that setting changes.
  const offenders: string[] = []
  for (const dir of ['web/src', 'extensions'])
    for (const [path, text] of sources(dir)) {
      // The coarse-pointer rule is the one place a px size is wanted: below 16px iOS zooms a focused field.
      const body = text.replace(/@media \(pointer: coarse\)[\s\S]*?\n\}/, '')
      // A px line-height next to a rem font-size collapses the leading as the page font grows.
      if (
        /text-\[\d+(?:\.\d+)?px\]/.test(body) ||
        /font-size:\s*\d+(?:\.\d+)?px/.test(body) ||
        /leading-\[\d+(?:\.\d+)?px\]/.test(body)
      )
        offenders.push(`${dir}/${path}`)
    }
  expect(offenders).toEqual([])
})

it('keeps the body and prose sizes in rem so the whole UI scales', () => {
  const css = readFileSync(new URL('../web/src/index.css', import.meta.url), 'utf8')
  const body = /body\s*\{[^}]*font-size:\s*([\d.]+)(rem|px)/.exec(css)
  expect(body?.[2], 'body font-size is in px, so the browser setting cannot scale it').toBe('rem')
  // The one deliberate px rule: below 16px iOS zooms the page when a field takes focus.
  const touch = /@media \(pointer: coarse\)[\s\S]*?font-size:\s*(\d+)px/.exec(css)
  expect(Number(touch?.[1])).toBeGreaterThanOrEqual(16)
})
