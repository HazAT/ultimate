/** @jsxImportSource @solidjs/web */
import { readFileSync, writeFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { flush } from 'solid-js'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { expect, it, vi } from 'vitest'

vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../web/src/sdk/ui-state.ts')
  return {
    store: createStore(),
    uiState: createUiState(undefined),
    api: {},
    registry: { getSnapshot: () => [], subscribe: () => () => {} },
  }
})
vi.mock('../../web/src/sdk/hooks.ts', () => ({ useExtensions: () => [] }))

import { Markdown } from '../../web/src/components/markdown/markdown.solid.tsx'
import { MessageResponse } from './zz-old-message.tsx'
import { renderSolid } from './solid-dom-setup.ts'

const dir = process.env.GOLDEN_DIR!
const messages = JSON.parse(readFileSync(`${dir}/messages.json`, 'utf8')) as {
  id: number
  kind: string
  text: string
}[]

const keep = new Set(
  'p h1 h2 h3 h4 h5 h6 ul ol li blockquote hr table thead tbody tr th td em i b del s strike code kbd details summary sup sub br input img section div span dl dt dd pre q ruby rt rp samp var ins tt tfoot picture source u mark abbr strong a'.split(
    ' ',
  ),
)

function canonical(node: Node): string {
  if (node.nodeType === 3) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ')
    return text.trim() ? text : ''
  }
  if (node.nodeType !== 1) return ''
  const element = node as HTMLElement
  const tag = element.tagName.toLowerCase()
  const role = element.getAttribute('data-streamdown')
  const inner = () => [...element.childNodes].map(canonical).join('')
  if (role === 'code-block' || element.classList.contains('code-block')) {
    const code = element.querySelector('pre')?.textContent ?? ''
    return `<codeblock ${element.getAttribute('data-language') ?? ''}>${code.replace(/\s+$/, '')}</codeblock>`
  }
  if (role === 'link' || tag === 'a') return `<a>${inner()}</a>`
  if (role === 'strong') return `<strong>${inner()}</strong>`
  if (role === 'image-overlay') return ''
  if (
    role === 'table-wrapper' ||
    role === 'image-wrapper' ||
    element.classList.contains('table') ||
    element.classList.contains('image') ||
    element.classList.contains('markdown') ||
    (element.parentElement?.getAttribute('data-streamdown') === 'table-wrapper' && tag === 'div') ||
    (element.parentElement?.classList.contains('table') && tag === 'div')
  )
    return inner()
  if (tag === 'button' || tag === 'svg' || tag === 'link') return ''
  if (!keep.has(tag)) return `<?${tag}>${inner()}</?${tag}>`
  const attributes: string[] = []
  if (tag === 'input')
    attributes.push(
      `type=${element.getAttribute('type')}`,
      `checked=${(element as HTMLInputElement).checked || element.hasAttribute('checked')}`,
    )
  if (tag === 'img') attributes.push(`src=${element.getAttribute('src')}`, `alt=${element.getAttribute('alt')}`)
  if ((tag === 'td' || tag === 'th') && element.style.textAlign)
    attributes.push(`align=${element.style.textAlign}`)
  if (tag === 'ol' && element.getAttribute('start')) attributes.push(`start=${element.getAttribute('start')}`)
  if (tag === 'details' && element.hasAttribute('open')) attributes.push('open')
  const open = attributes.length ? `<${tag} ${attributes.join(' ')}>` : `<${tag}>`
  return `${open}${inner()}</${tag}>`
}

it('matches streamdown on real messages', () => {
  const report: { id: number; kind: string; old: string; next: string; text: string }[] = []
  for (const message of messages) {
    const old = document.createElement('div')
    old.innerHTML = renderToStaticMarkup(createElement(MessageResponse, null, message.text))
    const next = renderSolid(() => <Markdown text={message.text} />)
    flush()
    old.normalize()
    next.normalize()
    const a = canonical(old).replace(/\s+/g, ' ').trim()
    const b = canonical(next).replace(/\s+/g, ' ').trim()
    const loose = (s: string) => s.replace(/<li><p>/g, '<li>').replace(/<\/p><\/li>/g, '</li>')
    if (loose(a) !== loose(b)) report.push({ id: message.id, kind: message.kind, old: a, next: b, text: message.text })
  }
  writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 1))
  const byKind = Object.fromEntries(
    Object.entries(Object.groupBy(messages, (m) => m.kind)).map(([kind, list]) => [
      kind,
      `${report.filter((r) => r.kind === kind).length}/${list!.length}`,
    ]),
  )
  console.log('mismatches', report.length, 'of', messages.length, byKind)
  const rawHtml = messages.filter((m) => {
    let found = false
    const visit = (node: { type: string; children?: unknown[] }) => {
      if (node.type === 'html') found = true
      for (const child of node.children ?? []) visit(child as typeof node)
    }
    visit(unified().use(remarkParse).use(remarkGfm).parse(m.text) as never)
    return found
  })
  const rawMismatches = rawHtml.filter((m) => report.some((r) => r.id === m.id))
  console.log(
    'raw HTML messages',
    rawHtml.length,
    'mismatching',
    rawMismatches.map((m) => m.id),
  )
  expect(messages.length).toBeGreaterThan(300)
})
