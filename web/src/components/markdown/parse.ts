import type { Element, ElementContent } from 'hast'
import { harden } from 'rehype-harden'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import remend from 'remend'
import { unified } from 'unified'
import { remarkMentions } from '../ai/mentions.ts'

export const incompleteLink = 'streamdown:incomplete-link'

const schema = {
  ...defaultSchema,
  clobberPrefix: '',
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), 'tel', 'streamdown'],
    src: [...(defaultSchema.protocols?.src ?? []), 'streamdown'],
  },
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), 'metastring'],
  },
}
const hardening = {
  allowedImagePrefixes: ['*'],
  allowedLinkPrefixes: ['*'],
  allowedProtocols: ['*'],
  defaultOrigin: undefined,
  allowDataImages: true,
}

const blocks = unified().use(remarkParse).use(remarkGfm)
const toHast = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMentions)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, schema)
  .use(harden, hardening)

export function parse(markdown: string): ElementContent[] {
  const tree = toHast.runSync(toHast.parse(markdown))
  return tree.children.filter((node) => node.type !== 'doctype')
}

export const closeUnfinished = (markdown: string) => remend(markdown)

const fenceMarks = (line: string) => /^[ \t>]*(`{3,}|~{3,})/.exec(line)?.[1]

export function fenceStillOpen(markdown: string, start: number, end: number) {
  if (markdown.slice(end).trim()) return false
  const lines = markdown.slice(start, end).trimEnd().split('\n')
  const opener = fenceMarks(lines[0])
  const last = lines.at(-1)!
  const closer = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/.exec(last)?.[1]
  return !(
    lines.length > 1 &&
    opener &&
    closer &&
    closer[0] === opener[0] &&
    closer.length >= opener.length
  )
}

const voidTags = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
])
function openTags(html: string) {
  let open = 0
  for (const [, closing, name, selfClosing] of html.matchAll(
    /<(\/?)([A-Za-z][\w:-]*)[^>]*?(\/?)>/g,
  ))
    if (!voidTags.has(name.toLowerCase()) && !selfClosing) open += closing ? -1 : 1
  return open
}

const endsAtBlankLine = /\n[ \t]*\n$/
const startsUnindented = /^[^\s]/

function split(markdown: string) {
  const tree = blocks.parse(markdown)
  const definesAcrossBlocks = tree.children.some(
    (node) => node.type === 'definition' || node.type === 'footnoteDefinition',
  )
  const starts = tree.children.map(
    (node) => markdown.lastIndexOf('\n', node.position!.start.offset! - 1) + 1,
  )
  const parts: string[] = []
  let open = 0
  for (const [index, start] of starts.entries()) {
    const text = markdown.slice(index === 0 ? 0 : start, starts[index + 1] ?? markdown.length)
    const node = tree.children[index]
    const previous = parts.at(-1)
    const settled =
      previous !== undefined &&
      open === 0 &&
      endsAtBlankLine.test(previous) &&
      startsUnindented.test(text)
    if (previous === undefined || settled) parts.push(text)
    else parts[parts.length - 1] += text
    if (node.type === 'html') open = Math.max(0, open + openTags(node.value))
  }
  return { parts: parts.length ? parts : [markdown], definesAcrossBlocks }
}

export function blockSplitterKeepingFinishedBlocks() {
  let kept: string[] = []
  return (markdown: string) => {
    const prefix = kept.join('')
    const grows = kept.length > 0 && markdown.startsWith(prefix)
    const rest = split(grows ? markdown.slice(prefix.length) : markdown)
    const parts = rest.definesAcrossBlocks
      ? [markdown]
      : grows
        ? kept.concat(rest.parts)
        : rest.parts
    kept = parts.slice(0, -1)
    return parts
  }
}

export type { Element, ElementContent }
