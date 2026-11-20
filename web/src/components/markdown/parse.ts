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

export function lastFenceOpen(markdown: string) {
  let fence: string | undefined
  for (const [, marks] of markdown.matchAll(/^ {0,3}(`{3,}|~{3,})/gm))
    if (!fence) fence = marks
    else if (marks[0] === fence[0] && marks.length >= fence.length) fence = undefined
  return fence !== undefined
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

const refersAcrossBlocks = (markdown: string) =>
  /\[\^[\w-]{1,200}\]/.test(markdown) || /^ {0,3}\[[^\]]+\]:/m.test(markdown)

function split(markdown: string): string[] {
  const tree = blocks.parse(markdown)
  const starts = tree.children.map((node) => node.position!.start.offset!)
  const parts: string[] = []
  let open = 0
  for (const [index, start] of starts.entries()) {
    const text = markdown.slice(index === 0 ? 0 : start, starts[index + 1] ?? markdown.length)
    const node = tree.children[index]
    if (open > 0) parts[parts.length - 1] += text
    else parts.push(text)
    if (node.type === 'html') open = Math.max(0, open + openTags(node.value))
  }
  return parts.length ? parts : [markdown]
}

export function blockSplitterKeepingFinishedBlocks() {
  let kept: string[] = []
  return (markdown: string) => {
    const prefix = kept.join('')
    const parts = refersAcrossBlocks(markdown)
      ? [markdown]
      : kept.length && markdown.startsWith(prefix)
        ? kept.concat(split(markdown.slice(prefix.length)))
        : split(markdown)
    kept = parts.slice(0, -1)
    return parts
  }
}

export type { Element, ElementContent }
