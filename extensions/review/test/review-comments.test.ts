import { expect, it } from 'vitest'
import {
  checkReview,
  code,
  draftsKey,
  excerptOf,
  fitsDraftBudget,
  languageOf,
  limits,
  reviewText,
} from '../comments.ts'
import { sha256 } from '../sha256.ts'

const bytes = (text: string) => new TextEncoder().encode(text).length

it('fences excerpts so their backticks cannot close the fence, with a language from the path', () => {
  const text = reviewText({
    spec: 'main...feature',
    comments: [
      {
        file: 'docs/a.md',
        side: 'new',
        start: 1,
        end: 2,
        excerpt: '```ts\nx\n```',
        text: ' Fix. ',
      },
      { file: 'Makefile', side: 'old', start: 9, end: 9, excerpt: '', text: 'Gone?' },
    ],
  })
  expect(text).toBe(
    [
      'Review of `main...feature` (2 comments)',
      '`docs/a.md:1-2` (new)\n````md\n```ts\nx\n```\n````\nFix.',
      '`Makefile:9` (old)\nGone?',
    ].join('\n\n'),
  )
  expect(languageOf('web/App.TSX')).toBe('tsx')
  expect(languageOf('.env')).toBe('')
})

it('keeps a file name with backticks and a newline on its own line, inside one code span', () => {
  const file = 'odd ``name`\nsecond.ts'
  const place = reviewText({
    spec: 'x',
    comments: [{ file, side: 'new', start: 2, end: 2, excerpt: '', text: 'Rename.' }],
  }).split('\n\n')[1]
  expect(place).toBe('```odd ``name`\\nsecond.ts:2``` (new)\nRename.')
  expect(code('`edge`')).toBe('`` `edge` ``')
  expect(code('tab\there')).toBe('`tab\\there`')
})

it('caps excerpts by lines and by UTF-8 bytes, at whole lines or within one huge line', () => {
  const lines = Array.from({ length: 60 }, (_, index) => `line ${index}`)
  expect(excerptOf(lines).split('\n')).toHaveLength(limits.excerptLines)
  // 30 lines of 150 × `é€` (2 + 3 bytes): 750 bytes each, so ten whole lines and their newlines fit in 8 KB.
  const wide = Array.from({ length: 30 }, () => 'é€'.repeat(150))
  const capped = excerptOf(wide)
  expect(capped.split('\n')).toHaveLength(10)
  expect(bytes(capped)).toBeLessThanOrEqual(limits.excerptBytes)
  const huge = excerptOf(['€'.repeat(5000)])
  expect(bytes(huge)).toBeLessThanOrEqual(limits.excerptBytes)
  expect(huge).toBe('€'.repeat(Math.floor(limits.excerptBytes / 3)))
  // What it quotes always passes the check.
  for (const excerpt of [capped, huge])
    expect(() =>
      checkReview({
        spec: 'x',
        comments: [{ file: 'a', side: 'new', start: 1, end: 1, excerpt, text: 'ok' }],
      }),
    ).not.toThrow()
})

it('drops a blank note and refuses a review without a spec', () => {
  const review = checkReview({
    spec: 'x',
    note: '  ',
    comments: [{ file: 'a', side: 'new', start: 1, end: 1, excerpt: '', text: 'ok' }],
  })
  expect(review).not.toHaveProperty('note')
  expect(() => checkReview({ spec: '', comments: [] })).toThrow('spec')
})

/** What the server accepts as a UI state key (server/api.ts `validUiKey`), with the `ext.review.` prefix. */
const valid = (key: string) => `ext.review.${key}`.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(key)

it('keeps drafts apart per spec and per worktree, in keys UI state accepts', () => {
  const keys = [
    draftsKey('uncommitted'),
    draftsKey('uncommitted', 12),
    draftsKey('uncommitted', 13),
    draftsKey('branch:ultimate/a-1'),
    draftsKey('branch:ultimate/a_1'),
    draftsKey('a...b'),
    draftsKey(`${'f'.repeat(40)}...${'e'.repeat(40)}`),
    draftsKey(`${'f'.repeat(40)}...${'d'.repeat(40)}`),
  ]
  expect(new Set(keys).size).toBe(keys.length)
  for (const key of [...keys, draftsKey('x'.repeat(500)), draftsKey('ü / weird`spec')])
    expect(valid(key)).toBe(true)
  // Long specs that differ only at the end are named by a hash of the whole spec.
  const [a, b] = [
    draftsKey(`branch:${'a'.repeat(141)}Aa`),
    draftsKey(`branch:${'a'.repeat(141)}BB`),
  ]
  expect(a).not.toBe(b)
  expect(a).toBe(`drafts:project:sha256-${sha256(`branch:${'a'.repeat(141)}Aa`)}`)
  expect(valid(a)).toBe(true)
})

it('hashes with SHA-256', () => {
  expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  // Two blocks, and multibyte text hashed as UTF-8.
  expect(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  )
  // Digests from node:crypto.
  expect(sha256('ü')).toBe('607474ca475a9724d7360aba71a56d5df77e61350e3f724cfa1f46e857e2d85f')
  expect(sha256('x'.repeat(1000) + '€'.repeat(300))).toBe(
    '4d187d7b71f3089a91068af7f5db8b8dd21d29f9fce7162b646a57b34443d2ad',
  )
})

/** `count` drafts of `text`, as drafts.ts stores them: without excerpts. */
const drafts = (count: number, text: string) => ({
  note: '',
  comments: Array.from({ length: count }, (_, index) => ({
    id: String(index),
    file: 'src/app.ts',
    side: 'new',
    start: 1,
    end: 1,
    text,
  })),
})

it('keeps drafts within their budget, but always lets them shrink', () => {
  // 50 comments of 1,000 characters fit; 50 of 4,000 do not.
  expect(fitsDraftBudget(drafts(50, 'x'.repeat(1000)), drafts(49, 'x'.repeat(1000)))).toBe(true)
  const full = drafts(30, 'x'.repeat(4000))
  expect(fitsDraftBudget(full, drafts(29, 'x'.repeat(4000)))).toBe(false)
  expect(fitsDraftBudget(drafts(29, 'x'.repeat(4000)), full)).toBe(true)
})
