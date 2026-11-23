import type { Definition, Link, Nodes } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

export type Block = {
  source: string
  start: number
  end: number
  frontMatter?: true
}

const newlines = (text: string) => text.split('\n').length - 1

export function frontMatterOf(source: string) {
  const match = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(source)
  return match?.[0] ?? ''
}

export function blocksOf(source: string, split: (markdown: string) => string[]): Block[] {
  const text = source.replace(/\r\n?/g, '\n')
  const front = frontMatterOf(text)
  const blocks: Block[] = []
  let line = 1
  if (front) {
    const body = front.replace(/\n$/, '')
    blocks.push({ source: body, start: 1, end: 1 + newlines(body), frontMatter: true })
    line += newlines(front)
  }
  const rest = text.slice(front.length)
  let cursor = 0
  for (const part of split(rest)) {
    const at = rest.indexOf(part, cursor)
    const offset = at === -1 ? cursor : at
    line += newlines(rest.slice(cursor, offset))
    cursor = offset + part.length
    const blankLinesBefore = /^(?:[ \t]*\n)*/.exec(part)![0]
    const body = part
      .slice(blankLinesBefore.length)
      .replace(/(?:\n[ \t]*)*\n?$/, '')
      .replace(/^[ \t]+$/, '')
    const first = line + newlines(blankLinesBefore)
    line += newlines(part)
    if (!body) continue
    blocks.push({ source: body, start: first, end: first + newlines(body) })
  }
  return blocks
}

export const normal = (text: string) =>
  text
    .toLowerCase()
    .replace(/[*_`~#>|\\[\]()!:-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const PROBE = 24

export const shownText = (line: string) =>
  line
    .replace(/^\s{0,3}\[[^\]]+\]:\s.*$/, '')
    .replace(/<!--.*?-->/g, '')
    .replace(/\]\((?:[^()\s]|\([^()]*\))*(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g, ']')
    .replace(/\]\[[^\]]*\]/g, ']')
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?\/?>/gi, '')

function occurrences(text: string, probe: string) {
  const haystack = normal(text)
  let count = 0
  for (let at = haystack.indexOf(probe); at !== -1; at = haystack.indexOf(probe, at + probe.length))
    count++
  return count
}

export function selectedLines(
  lines: readonly string[],
  first: Block,
  last: Block,
  selected: string,
  around: { before: string; after: string } = { before: '', after: '' },
) {
  const shown = selected.split('\n').map(normal).filter(Boolean)
  if (!shown.length) return { start: first.start, end: last.end }
  const head = shown[0].slice(0, PROBE)
  const tail = shown.at(-1)!.slice(-PROBE)
  const nthOccurrenceLine = (
    from: number,
    to: number,
    probe: string,
    step: 1 | -1,
    skip: number,
  ) => {
    let found: number | undefined
    let seen = 0
    for (let line = from; step > 0 ? line <= to : line >= to; line += step) {
      const here = occurrences(shownText(lines[line - 1] ?? ''), probe)
      if (!here) continue
      found ??= line
      seen += here
      if (seen > skip) return line
    }
    return found
  }
  const start =
    nthOccurrenceLine(first.start, first.end, head, 1, occurrences(around.before, head)) ??
    first.start
  const end =
    nthOccurrenceLine(last.end, last.start, tail, -1, occurrences(around.after, tail)) ?? last.end
  return end >= start ? { start, end } : { start: first.start, end: last.end }
}

export const ANCHOR_CHARS = 2000

export const anchorOf = (lines: readonly string[], start: number, end: number) =>
  lines
    .slice(start - 1, end)
    .join('\n')
    .slice(0, ANCHOR_CHARS)

export type Placed = { start: number; end: number; changed?: true }

export function place(
  draft: { start: number; end: number; anchor: string; excerpt: string },
  lines: readonly string[],
): Placed {
  const span = draft.end - draft.start
  const total = Math.max(lines.length, 1)
  const at = (start: number) => lines.slice(start - 1, start + span).join('\n')
  if (at(draft.start).startsWith(draft.anchor)) return { start: draft.start, end: draft.end }
  const nearest = (test: (line: number) => boolean) => {
    let best: number | undefined
    for (let line = 1; line <= lines.length; line++)
      if (
        test(line) &&
        (best === undefined || Math.abs(line - draft.start) < Math.abs(best - draft.start))
      )
        best = line
    return best
  }
  const clamp = (start: number) => ({ start, end: Math.min(start + span, total) })
  const moved = draft.anchor ? nearest((line) => at(line).startsWith(draft.anchor)) : undefined
  if (moved !== undefined) return clamp(moved)
  const words = normal(draft.excerpt.split('\n').find((line) => normal(line)) ?? '').slice(0, PROBE)
  const found =
    words.length >= 8 ? nearest((line) => normal(lines[line - 1] ?? '').includes(words)) : undefined
  if (found !== undefined) return clamp(found)
  const start = Math.min(draft.start, total)
  return { start, end: Math.min(Math.max(draft.end, start), total), changed: true }
}

export function blockAt(blocks: readonly Block[], line: number) {
  let index = 0
  for (let i = 0; i < blocks.length; i++) if (blocks[i].start <= line) index = i
  return index
}

export type Target = { path: string; line?: number }

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

const mdPath = (name: string) =>
  new RegExp(
    `^(?![a-z][a-z0-9+.-]*:)(?!~)(${name}+\\.(?:md|markdown))(?::(\\d+)(?:-\\d+)?|#(?:L(\\d+)(?:-L?\\d+)?|[\\w-]*))?$`,
    'i',
  )
const CODE_PATH = mdPath(`[^\\s:#?"'<>|*]`)

export function markdownTarget(text: string): Target | undefined {
  const match = CODE_PATH.exec(text.trim())
  if (!match) return undefined
  const line = Number(match[2] ?? match[3])
  return { path: match[1], ...(line > 0 ? { line } : {}) }
}

function decoded(href: string) {
  const hash = href.indexOf('#')
  const path = hash === -1 ? href : href.slice(0, hash)
  try {
    return {
      path: path.split('/').map(decodeURIComponent).join('/'),
      fragment: hash === -1 ? '' : href.slice(hash),
    }
  } catch {
    return undefined
  }
}

const MARKDOWN_FILE = /\.(?:md|markdown)$/i

export const isLocalHref = (href: string) =>
  !SCHEME.test(href) && !href.startsWith('~') && !href.startsWith('//')

export function hrefTarget(href: string): Target | undefined {
  if (!isLocalHref(href)) return undefined
  const parts = decoded(href)
  if (!parts) return undefined
  const path = parts.path.replace(/^\.\//, '')
  if (!MARKDOWN_FILE.test(path) || /[\n\0]/.test(path)) return undefined
  const line = Number(/^#L(\d+)/.exec(parts.fragment)?.[1])
  return { path, ...(line > 0 ? { line } : {}) }
}

const markdownTree = unified().use(remarkParse).use(remarkGfm)

const relativeHref = (url: string) =>
  url !== '' && isLocalHref(url) && !url.startsWith('/') && !url.startsWith('#')

function destinationAt(markdown: string, from: number) {
  let start = from
  while (/\s/.test(markdown[start] ?? '')) start++
  if (markdown[start] === '<') {
    const end = markdown.indexOf('>', start)
    return end === -1 ? undefined : { from: start + 1, to: end }
  }
  let end = start
  let depth = 0
  for (; end < markdown.length; end++) {
    const char = markdown[end]
    if (/\s/.test(char) || (char === ')' && depth === 0)) break
    if (char === '\\') end++
    else if (char === '(') depth++
    else if (char === ')') depth--
  }
  return end > start ? { from: start, to: end } : undefined
}

function destinationOf(markdown: string, node: Link | Definition) {
  const start = node.position?.start.offset
  if (start === undefined) return undefined
  if (node.type === 'definition') {
    const colon = markdown.indexOf(']:', start)
    return colon === -1 ? undefined : destinationAt(markdown, colon + 2)
  }
  const textEnd = node.children.at(-1)?.position?.end.offset ?? start + 1
  return markdown.startsWith('](', textEnd) ? destinationAt(markdown, textEnd + 2) : undefined
}

const folderUrl = (folder: string) =>
  `file://${folder.split('/').map(encodeURIComponent).join('/').replace(/\/?$/, '/')}`

export function localLinks(markdown: string, absoluteFolder: string) {
  const edits: { from: number; to: number; href: string }[] = []
  const visit = (node: Nodes) => {
    if ((node.type === 'link' || node.type === 'definition') && relativeHref(node.url)) {
      const range = destinationOf(markdown, node)
      const url = new URL(node.url, folderUrl(absoluteFolder))
      if (range) edits.push({ ...range, href: url.pathname + url.search + url.hash })
    }
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(markdownTree.parse(markdown))
  let result = markdown
  for (const edit of edits.toSorted((a, b) => b.from - a.from))
    result = result.slice(0, edit.from) + edit.href + result.slice(edit.to)
  return result
}

export const folderOf = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''

const SPEC = 'read:'

export const readSpec = (absolute: string) => SPEC + absolute

export const chipTarget = (spec: string, comment: { start: number }) => ({
  path: spec.slice(SPEC.length),
  line: comment.start,
})

export const isReadReview = (data: unknown): data is { spec: string } =>
  !!data &&
  typeof data === 'object' &&
  typeof (data as { spec?: unknown }).spec === 'string' &&
  (data as { spec: string }).spec.startsWith(SPEC)
