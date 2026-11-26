import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** The inline script `index.html` runs before any module: it paints the stored view. */
const paint = /<script>\s*(\/\/ A reload paints[\s\S]*?)<\/script>/.exec(
  readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8'),
)![1]

/** A text node: no box of its own, copied whole. */
class Text {
  data: string
  constructor(data: string) {
    this.data = data
  }
  cloneNode() {
    return new Text(this.data)
  }
  get outerHTML() {
    return this.data
  }
}

/** Just enough of an element for both halves: markup derived from its dataset, scroll offsets, children, a box. */
class Element {
  id = ''
  inert = false
  textContent = ''
  /** A string once the inline script sets it, as the browser would coerce. */
  scrollTop: number | string = 0
  scrollLeft = 0
  dataset: Record<string, string> = {}
  style = { cssText: '' }
  children: (Element | Text)[] = []
  box = { top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 }
  tagName: string
  constructor(tagName: string) {
    this.tagName = tagName
  }
  get childNodes() {
    return this.children
  }
  getBoundingClientRect() {
    return this.box
  }
  getClientRects() {
    return [this.box]
  }
  cloneNode(deep: boolean) {
    const clone = Object.assign(new Element(this.tagName), { id: this.id })
    if (deep) clone.children = this.children.map((child) => child.cloneNode(true))
    if (deep) clone.textContent = this.textContent
    return clone
  }
  get outerHTML(): string {
    const scroll = this.dataset.resumeScroll
    const attributes = `${this.id ? ` id="${this.id}"` : ''}${scroll ? ` data-resume-scroll="${scroll}"` : ''}${this.style.cssText ? ` style="${this.style.cssText}"` : ''}`
    return `<${this.tagName.toLowerCase()}${attributes}>${this.innerHTML}</${this.tagName.toLowerCase()}>`
  }
  get innerHTML(): string {
    return this.textContent + this.children.map((child) => child.outerHTML).join('')
  }
  /** Parses back what `outerHTML` writes, flat: each element with a scroll offset becomes a child. */
  set innerHTML(html: string) {
    this.children = [...html.matchAll(/data-resume-scroll="([^"]*)"/g)].map(([, scroll]) => {
      const element = new Element('DIV')
      element.dataset.resumeScroll = scroll!
      return element
    })
  }
  prepend(child: Element) {
    this.children.unshift(child)
  }
  append(...children: (Element | Text)[]) {
    this.children.push(...children)
  }
  /** Every descendant element for `*`, otherwise those marked with a scroll offset. */
  querySelectorAll(selector = '*'): Element[] {
    const all = this.children.flatMap((child): Element[] =>
      child instanceof Element ? [child, ...child.querySelectorAll()] : [],
    )
    return selector === '*' ? all : all.filter((element) => element.dataset.resumeScroll)
  }
}

function page(stored?: string) {
  const listeners = new Map<string, () => void>()
  const items = new Map<string, string>(stored ? [['ultimate.resume', stored]] : [])
  const sessionStorage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key),
  }
  const body = new Element('BODY')
  const document = {
    body,
    styleSheets: [] as { cssRules: { cssText: string }[] }[],
    getElementById: (id: string) =>
      body.querySelectorAll().find((element) => element.id === id) ?? null,
    createElement: (tag: string) => new Element(tag.toUpperCase()),
    querySelectorAll: () => [],
  }
  return {
    document,
    sessionStorage,
    items,
    body,
    location: { search: '' },
    listeners,
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('resuming a reload', () => {
  it('paints what the previous page showed, styles and scroll offsets included', async () => {
    const before = page()
    const app = Object.assign(new Element('DIV'), { id: 'app' })
    const transcript = Object.assign(new Element('DIV'), { scrollTop: 420 })
    const earlier = new Element('P')
    earlier.append(new Text('long ago '.repeat(1000)))
    earlier.box = {
      top: -900,
      bottom: -600,
      left: 0,
      right: 100,
      width: 100,
      height: 300,
    }
    const latest = new Element('P')
    latest.append(new Text('just now'))
    transcript.append(earlier)
    transcript.append(latest)
    app.append(transcript)
    before.body.append(app)
    before.body.append(new Element('SCRIPT'))
    before.document.styleSheets.push({
      cssRules: [{ cssText: 'body { color: red; }' }],
    })
    vi.stubGlobal('document', before.document)
    vi.stubGlobal('sessionStorage', before.sessionStorage)
    vi.stubGlobal('HTMLElement', Element)
    vi.stubGlobal('HTMLTextAreaElement', class extends Element {})
    vi.stubGlobal('getComputedStyle', () => ({
      margin: '16px 0px',
      position: 'static',
    }))
    vi.stubGlobal('innerWidth', 1200)
    vi.stubGlobal('innerHeight', 800)
    vi.stubGlobal('location', { search: '' })
    vi.stubGlobal('addEventListener', before.addEventListener)
    const { rendered } = await import('../../web/src/sdk/resume.ts')
    before.listeners.get('pagehide')!()
    expect(before.items.size).toBe(0)
    rendered()
    before.listeners.get('pagehide')!()
    const stored = before.items.get('ultimate.resume')!
    // Off screen, the earlier message keeps its room but not its content.
    expect(stored).toContain('just now')
    expect(stored).not.toContain('long ago')
    expect(stored).toContain('width:100px;height:300px;margin:16px 0px;flex:none')
    expect(transcript.dataset.resumeScroll).toBeUndefined()

    const after = page(stored)
    runInNewContext(paint, after)
    const [view] = after.body.querySelectorAll()
    expect(view.id).toBe('resume')
    expect(view.inert).toBe(true)
    const [style] = view.querySelectorAll()
    const [scrolled] = view.querySelectorAll('[data-resume-scroll]')
    expect(style.textContent).toContain('body { color: red; }')
    expect(Number(scrolled.scrollTop)).toBe(420)
  })

  it('saves the readable stylesheets and reading place when a stylesheet is inaccessible', async () => {
    const before = page()
    before.document.styleSheets.push(
      {
        get cssRules(): never {
          throw new DOMException('Cannot access rules', 'SecurityError')
        },
      },
      { cssRules: [{ cssText: 'body { color: red; }' }] },
    )
    vi.stubGlobal('document', before.document)
    vi.stubGlobal('sessionStorage', before.sessionStorage)
    vi.stubGlobal('addEventListener', before.addEventListener)
    const { rendered, keepAcrossReload } = await import('../../web/src/sdk/resume.ts')
    keepAcrossReload('draft', () => 'unfinished')
    rendered()
    before.listeners.get('pagehide')!()
    expect(JSON.parse(before.items.get('ultimate.resume') ?? 'null')).toMatchObject({
      css: 'body { color: red; }',
    })
    expect(JSON.parse(before.items.get('ultimate.resume-place') ?? 'null')).toMatchObject({
      kept: { draft: 'unfinished' },
    })
  })

  it('saves the reading place even when cover capture throws', async () => {
    const before = page()
    const error = new Error('Stylesheet capture failed')
    before.document.styleSheets.push({
      get cssRules(): never {
        throw error
      },
    })
    vi.stubGlobal('document', before.document)
    vi.stubGlobal('sessionStorage', before.sessionStorage)
    vi.stubGlobal('addEventListener', before.addEventListener)
    const { rendered, keepAcrossReload } = await import('../../web/src/sdk/resume.ts')
    keepAcrossReload('draft', () => 'unfinished')
    rendered()
    expect(before.listeners.get('pagehide')).toThrow(error)
    expect(before.items.get('ultimate.resume')).toBeUndefined()
    expect(JSON.parse(before.items.get('ultimate.resume-place') ?? 'null')).toMatchObject({
      kept: { draft: 'unfinished' },
    })
  })

  it('starts fresh without a view, or with one stored long ago', () => {
    const none = page()
    runInNewContext(paint, none)
    expect(none.body.children).toEqual([])
    const stale = page(JSON.stringify({ at: Date.now() - 60000, html: '', css: '' }))
    runInNewContext(paint, stale)
    expect(stale.body.children).toEqual([])
  })
})
