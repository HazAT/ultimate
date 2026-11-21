import type { ConversationId } from '@earendil-works/pi-durable'

import { sha256 } from './sha256.ts'
import type { ReviewComment, ReviewComments } from './types.ts'

export type { ReviewComment, ReviewComments } from './types.ts'

const DRAFTS_BUDGET_BYTES = 96 * 1024
const UI_KEY_SPEC_LIMIT = 140

export const limits = {
  comments: 50,
  text: 4000,
  excerptLines: 40,
  excerptBytes: 8 * 1024,

  drafts: DRAFTS_BUDGET_BYTES,
} as const

const bytes = (text: string) => new TextEncoder().encode(text).length

export function fitsDraftBudget(next: unknown, before: unknown) {
  const size = bytes(JSON.stringify(next))
  const withinBudgetOrNotGrowing = size <= limits.drafts || size <= bytes(JSON.stringify(before))
  return withinBudgetOrNotGrowing
}

export function excerptOf(lines: readonly string[]) {
  const kept: string[] = []
  let size = 0
  for (const line of lines.slice(0, limits.excerptLines)) {
    const next = size + (kept.length ? 1 : 0) + bytes(line)
    if (next > limits.excerptBytes) {
      if (kept.length) break
      let cut = ''
      let used = 0
      for (const char of line) {
        used += bytes(char)
        if (used > limits.excerptBytes) break
        cut += char
      }
      return cut
    }
    kept.push(line)
    size = next
  }
  return kept.join('\n')
}

export function draftsKey(spec: string, conversation?: ConversationId) {
  const escapedSpecWithoutHyphens = spec.replace(
    /[^A-Za-z0-9.]/g,
    (char) => `_${char.codePointAt(0)!.toString(16)}_`,
  )
  const name =
    escapedSpecWithoutHyphens.length <= UI_KEY_SPEC_LIMIT
      ? escapedSpecWithoutHyphens
      : `sha256-${sha256(spec)}`
  return `drafts:${conversation ?? 'project'}:${name}`
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const line = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

export function checkReview(input: unknown): ReviewComments {
  if (!record(input)) throw new Error('Expected { spec, comments, note? }')
  const { spec, comments, note } = input
  if (typeof spec !== 'string' || !spec.trim()) throw new Error('spec must be a non-empty string')
  if (!Array.isArray(comments) || comments.length === 0)
    throw new Error('comments must be a non-empty list')
  if (comments.length > limits.comments)
    throw new Error(`At most ${limits.comments} comments per review`)
  if (note !== undefined && (typeof note !== 'string' || note.length > limits.text))
    throw new Error(`note must be text of at most ${limits.text} characters`)
  const checked = comments.map((comment, index): ReviewComment => {
    const at = `comments[${index}]`
    if (!record(comment)) throw new Error(`${at} must be an object`)
    const { file, side, start, end, excerpt, text } = comment
    if (typeof file !== 'string' || !file) throw new Error(`${at}.file must be a path`)
    if (side !== 'old' && side !== 'new') throw new Error(`${at}.side must be old or new`)
    if (!line(start) || !line(end) || end < start)
      throw new Error(`${at} needs line numbers with start ≤ end`)
    if (typeof text !== 'string' || !text.trim()) throw new Error(`${at}.text must not be empty`)
    if (text.length > limits.text)
      throw new Error(`${at}.text is longer than ${limits.text} characters`)
    if (typeof excerpt !== 'string') throw new Error(`${at}.excerpt must be text`)
    if (excerpt.split('\n').length > limits.excerptLines)
      throw new Error(`${at}.excerpt is longer than ${limits.excerptLines} lines`)
    if (new TextEncoder().encode(excerpt).length > limits.excerptBytes)
      throw new Error(`${at}.excerpt is larger than ${limits.excerptBytes / 1024} KB`)
    return { file, side, start, end, excerpt, text }
  })
  return { spec, comments: checked, ...(note?.trim() ? { note: note.trim() } : {}) }
}

const languages: Record<string, string> = {
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
  json: 'json',
  md: 'md',
  css: 'css',
  html: 'html',
  py: 'python',
  rs: 'rust',
  go: 'go',
  sh: 'sh',
  bash: 'sh',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  java: 'java',
  kt: 'kotlin',
  rb: 'ruby',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
}

export function languageOf(path: string) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? (languages[name.slice(dot + 1).toLowerCase()] ?? '') : ''
}

export function code(value: string) {
  const escapedControlCharacters = value.replace(/\p{Cc}/gu, (char) =>
    JSON.stringify(char).slice(1, -1),
  )
  const delimiterLongerThanContentBackticks = '`'.repeat(
    Math.max(0, ...[...escapedControlCharacters.matchAll(/`+/g)].map((run) => run[0].length)) + 1,
  )
  const pad =
    escapedControlCharacters.startsWith('`') || escapedControlCharacters.endsWith('`') ? ' ' : ''
  return `${delimiterLongerThanContentBackticks}${pad}${escapedControlCharacters}${pad}${delimiterLongerThanContentBackticks}`
}

export const shortSpec = (spec: string) => spec.replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/g, '$1')

export const location = (comment: Pick<ReviewComment, 'file' | 'start' | 'end'>) =>
  `${comment.file}:${comment.start}${comment.end === comment.start ? '' : `-${comment.end}`}`

const fenceLongerThanExcerptBackticks = (text: string) =>
  '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((run) => run[0].length + 1)))

const plural = (count: number) => `${count} comment${count === 1 ? '' : 's'}`

export function reviewText({ spec, comments, note }: ReviewComments) {
  const parts = [`Review of ${code(spec)} (${plural(comments.length)})`]
  if (note) parts.push(note)
  for (const comment of comments) {
    const quote = fenceLongerThanExcerptBackticks(comment.excerpt)
    parts.push(
      [
        `${code(location(comment))} (${comment.side})`,
        ...(comment.excerpt ? [`${quote}${languageOf(comment.file)}`, comment.excerpt, quote] : []),
        comment.text.trim(),
      ].join('\n'),
    )
  }
  return parts.join('\n\n')
}

export { plural as commentCount }
