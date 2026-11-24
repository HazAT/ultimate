import { expect, it } from 'vitest'
import { blockSplitterKeepingFinishedBlocks } from '../../../web/src/components/markdown/parse.ts'
import {
  blockAt,
  blocksOf,
  chipTarget,
  hrefTarget,
  isReadReview,
  localLinks,
  markdownTarget,
  place,
  readSpec,
  selectedLines,
  shownText,
} from '../blocks.ts'

const split = (markdown: string) => blockSplitterKeepingFinishedBlocks()(markdown)
const whole = (markdown: string) => [markdown]

const SAMPLE = [
  '---',
  'title: Plan',
  'tags: [a, b]',
  '---',
  '',
  '# Heading',
  '',
  'First paragraph',
  'wraps onto **two** lines.',
  '',
  '- one',
  '- two',
  '  - nested',
  '',
  '```ts',
  'const a = 1',
  '',
  'const b = 2',
  '```',
  '',
  '## Last',
  '',
].join('\n')

const lines = SAMPLE.split('\n')
const blocks = blocksOf(SAMPLE, split)

it('splits a file into the blocks chat renders, each with its source lines and front matter apart', () => {
  expect(blocks.map(({ start, end, frontMatter }) => [start, end, frontMatter ?? false])).toEqual([
    [1, 4, true],
    [6, 6, false],
    [8, 9, false],
    [11, 13, false],
    [15, 19, false],
    [21, 21, false],
  ])
  for (const block of blocks)
    expect(lines.slice(block.start - 1, block.end).join('\n')).toBe(block.source)
  expect(blockAt(blocks, 17)).toBe(4)
  expect(blockAt(blocks, 20)).toBe(4)
  expect(blocksOf('---\n\nAfter a rule\n', whole)[0]?.frontMatter).toBeUndefined()
})

it('keeps an indented code block indented, on its own lines', () => {
  const source = '\n\n    indented code\n      more\n\n  \nafter\n'
  expect(blocksOf(source, split).map(({ source: text, start, end }) => [text, start, end])).toEqual(
    [
      ['    indented code\n      more', 3, 4],
      ['after', 7, 7],
    ],
  )
})

it('narrows a selection to the lines it covers', () => {
  const [, heading, paragraph, list] = blocks
  expect(selectedLines(lines, list, list, 'two\nnested')).toEqual({ start: 12, end: 13 })
  expect(selectedLines(lines, paragraph, paragraph, 'wraps onto two lines.')).toEqual({
    start: 9,
    end: 9,
  })
  expect(selectedLines(lines, heading, list, 'Heading\nFirst paragraph wraps\none')).toEqual({
    start: 6,
    end: 11,
  })
  expect(selectedLines(lines, paragraph, paragraph, 'nothing like it')).toEqual({
    start: 8,
    end: 9,
  })
})

it('maps a selection of repeated words to the occurrence that was selected', () => {
  const repeated = ['- Repeat', '- Repeat', '- Repeat']
  const [list] = blocksOf(`${repeated.join('\n')}\n`, whole)
  const around = (before: string, after: string) => ({ before, after })
  expect(selectedLines(repeated, list, list, 'Repeat', around('Repeat\n', '\nRepeat'))).toEqual({
    start: 2,
    end: 2,
  })
  expect(selectedLines(repeated, list, list, 'Repeat\nRepeat', around('Repeat\n', ''))).toEqual({
    start: 2,
    end: 3,
  })
  expect(selectedLines(repeated, list, list, 'peat', around('RepeatRepeatRe', ''))).toEqual({
    start: 3,
    end: 3,
  })
  const linked = ['- [Repeat](Repeat.md)', '- Repeat']
  const [links] = blocksOf(`${linked.join('\n')}\n`, whole)
  expect(selectedLines(linked, links, links, 'Repeat', around('Repeat\n', ''))).toEqual({
    start: 2,
    end: 2,
  })
  expect(shownText('[Repeat](Repeat.md "Repeat") ![Repeat](r.png) [Repeat][repeat]')).toBe(
    '[Repeat] ![Repeat] [Repeat]',
  )
})

it('keeps a draft on its text when the file changes, and marks it when the text is gone', () => {
  const draft = { start: 11, end: 12, anchor: '- one\n- two', excerpt: 'one two' }
  expect(place(draft, lines)).toEqual({ start: 11, end: 12 })
  const moved = ['# New intro', '', ...lines]
  expect(place(draft, moved)).toEqual({ start: 13, end: 14 })
  const reworded = lines.map((line) => line.replace('- one', '- uno').replace('- two', '- dos'))
  expect(place(draft, reworded)).toEqual({ start: 11, end: 12, changed: true })
  const byExcerpt = {
    start: 8,
    end: 9,
    anchor: 'First paragraph\nold wording',
    excerpt: 'wraps onto two lines.',
  }
  expect(place(byExcerpt, moved)).toEqual({ start: 11, end: 12 })
})

it('opens markdown paths from code spans and links, and leaves web links alone', () => {
  expect(markdownTarget('docs/plan.md')).toEqual({ path: 'docs/plan.md' })
  expect(markdownTarget('docs/plan.md:12-14')).toEqual({ path: 'docs/plan.md', line: 12 })
  expect(markdownTarget('docs/plan.md#L7')).toEqual({ path: 'docs/plan.md', line: 7 })
  for (const text of ['web.tsx', 'two words.md', '~/notes.md'])
    expect(markdownTarget(text)).toBeUndefined()
  expect(hrefTarget('https://example.com/README.md')).toBeUndefined()
  expect(hrefTarget('mailto:someone@example.md')).toBeUndefined()
  expect(hrefTarget('/work/app/docs/a%20b.md#L3')).toEqual({
    path: '/work/app/docs/a b.md',
    line: 3,
  })
  expect(hrefTarget('other.md#a-heading')).toEqual({ path: 'other.md' })
})

it("rewrites a read file's relative links to its own folder, leaving code and other links alone", () => {
  const source = [
    'See [plan](plan.md#L4), [up](../README.md "Readme") and [ref][r].',
    '',
    '`[code](kept.md)` and [web](https://example.com/x.md) and [here](#top)',
    '',
    '[r]: <sub dir/b.md>',
  ].join('\n')
  const rewritten = localLinks(source, '/work/my app#1/docs')
  expect(rewritten.split('\n')).toHaveLength(5)
  expect(rewritten).toContain('[plan](/work/my%20app%231/docs/plan.md#L4)')
  expect(rewritten).toContain('[up](/work/my%20app%231/README.md "Readme")')
  expect(rewritten).toContain('[r]: </work/my%20app%231/docs/sub%20dir/b.md>')
  expect(rewritten).toContain(
    '`[code](kept.md)` and [web](https://example.com/x.md) and [here](#top)',
  )
  expect(hrefTarget('/work/my%20app%231/docs/plan.md#L4')).toEqual({
    path: '/work/my app#1/docs/plan.md',
    line: 4,
  })
})

it("gives only the reader's own reviews its card, whose chips reopen the absolute file", () => {
  const spec = readSpec('/work/app/docs/plan.md')
  expect(isReadReview({ spec, comments: [] })).toBe(true)
  for (const data of [{ spec: 'uncommitted' }, { spec: 'branch:read:x' }, null, 'read:x'])
    expect(isReadReview(data)).toBe(false)
  expect(chipTarget(spec, { start: 12 })).toEqual({ path: '/work/app/docs/plan.md', line: 12 })
})
