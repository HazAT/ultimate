import type { Element, ElementContent } from 'hast'
import type { Code, Nodes as MdastNodes } from 'mdast'
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

type CompileContext = { stack: MdastNodes[] }
type FenceToken = { start: { line: number } }

function remarkClosedFences(this: ReturnType<typeof unified>) {
  const data = this.data() as { fromMarkdownExtensions?: unknown[] }
  ;(data.fromMarkdownExtensions ??= []).push({
    enter: {
      codeFencedFence(this: CompileContext, token: FenceToken) {
        const code = this.stack.findLast((node): node is Code => node.type === 'code')
        if (code)
          code.data = {
            ...code.data,
            fence: code.position!.start.line === token.start.line ? 'open' : 'closed',
          }
      },
    },
  })
}

declare module 'mdast' {
  interface CodeData {
    fence?: 'open' | 'closed'
  }
}

const markdownTree = unified().use(remarkParse).use(remarkGfm).use(remarkClosedFences)
const toHast = unified()
  .use(remarkMentions)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, schema)
  .use(harden, hardening)

const continuation = 'C1STREAMPROBE'

function stillExtends(markdown: string, start: number) {
  const lineStart = markdown.lastIndexOf('\n', start - 1) + 1
  const container = markdown
    .slice(lineStart, start)
    .replace(/\[\^(?:\\.|[^\]\\])+\]:[ \t]*/, '    ')
    .replace(/[-*+]|\d+[.)]/g, (marker) => ' '.repeat(marker.length))
  const probed = `${markdown}${markdown.endsWith('\n') ? container : ''}${continuation}`
  const fence = descendants(markdownTree.parse(probed)).find(
    (node) => node.type === 'code' && node.position!.start.offset === start,
  )
  return fence !== undefined && fence.position!.end.offset! >= probed.length
}

function descendants(node: MdastNodes): MdastNodes[] {
  return 'children' in node ? node.children.flatMap((child) => [child, ...descendants(child)]) : []
}

export function parse(markdown: string): { nodes: ElementContent[]; openFences: number[] } {
  const mdast = markdownTree.parse(markdown)
  const last = descendants(mdast).findLast((node): node is Code => node.type === 'code')
  const start = last?.position!.start.offset
  const openFences =
    start !== undefined && last?.data?.fence === 'open' && stillExtends(markdown, start)
      ? [start]
      : []
  const tree = toHast.runSync(mdast, markdown)
  return { nodes: tree.children.filter((node) => node.type !== 'doctype'), openFences }
}

export const closeUnfinished = (markdown: string) => remend(markdown)

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
  const tree = markdownTree.parse(markdown)
  const definesAcrossBlocks = descendants(tree).some(
    (node) => node.type === 'definition' || node.type === 'footnoteDefinition',
  )
  const starts = tree.children.map(
    (node) => markdown.lastIndexOf('\n', node.position!.start.offset! - 1) + 1,
  )
  const parts: Part[] = []
  let open = 0
  for (const [index, start] of starts.entries()) {
    const text = markdown.slice(index === 0 ? 0 : start, starts[index + 1] ?? markdown.length)
    const node = tree.children[index]
    const previous = parts.at(-1)
    const settled =
      previous !== undefined &&
      open === 0 &&
      endsAtBlankLine.test(previous.text) &&
      startsUnindented.test(text)
    if (previous === undefined || settled) parts.push({ text, list: node.type === 'list' })
    else parts[parts.length - 1] = { text: previous.text + text, list: node.type === 'list' }
    if (node.type === 'html') open = Math.max(0, open + openTags(node.value))
  }
  return { parts: parts.length ? parts : [{ text: markdown, list: false }], definesAcrossBlocks }
}

type Part = { text: string; list: boolean }

export function blockSplitterKeepingFinishedBlocks() {
  let kept: Part[] = []
  return (markdown: string) => {
    const prefix = kept.map((part) => part.text).join('')
    const grows = kept.length > 0 && markdown.startsWith(prefix)
    const rest = split(grows ? markdown.slice(prefix.length) : markdown)
    const parts = rest.definesAcrossBlocks
      ? [{ text: markdown, list: false }]
      : grows
        ? kept.concat(rest.parts)
        : rest.parts
    kept = parts.slice(0, -1)
    if (kept.at(-1)?.list) kept.pop()
    return parts.map((part) => part.text)
  }
}

export type { Element, ElementContent }
