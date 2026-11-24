import { bundledLanguages, bundledLanguagesInfo, createHighlighter } from 'shiki'
import type {
  BundledLanguage,
  BundledTheme,
  GrammarState,
  HighlighterGeneric,
  ThemedToken,
} from 'shiki'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'

export type Line = ThemedToken[]

const themes = { light: 'vitesse-light', dark: 'vitesse-dark' } as const
const aliases = new Map(
  bundledLanguagesInfo.flatMap((info) => (info.aliases ?? []).map((alias) => [alias, info.id])),
)
const isBundled = (id: string): id is BundledLanguage => Object.hasOwn(bundledLanguages, id)
const languageOf = (name: string): BundledLanguage | 'text' => {
  const lower = name.trim().toLowerCase()
  const id = aliases.get(lower) ?? lower
  return isBundled(id) ? id : 'text'
}

export const supportsLanguage = (name: string) => languageOf(name) !== 'text'

const extensions: Record<string, string> = {
  cjs: 'js',
  mjs: 'js',
  cts: 'ts',
  mts: 'ts',
  sh: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  rs: 'rust',
  py: 'python',
  rb: 'ruby',
  kt: 'kotlin',
  h: 'c',
  hpp: 'cpp',
}

export function languageFromPath(path: string) {
  const name = path.split('/').at(-1)?.toLowerCase() ?? ''
  if (name === 'dockerfile' || name === 'makefile') return name
  const extension = name.includes('.') ? (name.split('.').at(-1) ?? '') : ''
  const language = extensions[extension] ?? extension
  return supportsLanguage(language) ? language : 'text'
}

type Highlighter = HighlighterGeneric<BundledLanguage, BundledTheme>
let highlighter: Highlighter | undefined
const starting = once(() =>
  createHighlighter({
    themes: [themes.light, themes.dark],
    langs: [],
    engine: createOnigurumaEngine(import('shiki/wasm')),
  }).then((created) => (highlighter = created)),
)
const loading = new Map<string, Promise<unknown>>()

function load(language: BundledLanguage | 'text') {
  let loaded = loading.get(language)
  if (!loaded) {
    loaded = starting().then((created) =>
      language === 'text' ? undefined : created.loadLanguage(language),
    )
    loading.set(language, loaded)
  }
  return loaded
}

function once<T>(make: () => T) {
  let made: { value: T } | undefined
  return () => (made ??= { value: make() }).value
}

const loadedLanguage = (language: string) =>
  highlighter !== undefined &&
  (language === 'text' || highlighter.getLoadedLanguages().includes(language))

const finished = new Map<string, Line[]>()
const finishedLimit = 500
const streaming = new Map<string, { prefix: string; lines: Line[]; state?: GrammarState }>()

function tokenize(created: Highlighter, code: string, language: BundledLanguage | 'text'): Line[] {
  const tokens = (text: string, state?: GrammarState) =>
    created.codeToTokens(text, { lang: language, themes, grammarState: state })
  const whole = code.lastIndexOf('\n') + 1
  let done = streaming.get(language)
  if (!done || !code.startsWith(done.prefix)) done = { prefix: '', lines: [] }
  if (whole > done.prefix.length) {
    const more = tokens(code.slice(done.prefix.length, whole), done.state)
    done = {
      prefix: code.slice(0, whole),
      lines: done.lines.concat(more.tokens.slice(0, -1)),
      state: more.grammarState,
    }
    streaming.set(language, done)
  }
  return done.lines.concat(tokens(code.slice(whole), done.state).tokens)
}

export function highlight(code: string, name: string, then: (lines: Line[]) => void) {
  const language = languageOf(name)
  const key = `${language}\n${code}`
  const known = finished.get(key)
  if (known) return known
  if (!loadedLanguage(language)) {
    void load(language).then(() => then(highlight(code, name, then) ?? []))
    return undefined
  }
  const lines = tokenize(highlighter!, code, language)
  finished.set(key, lines)
  if (finished.size > finishedLimit) finished.delete(finished.keys().next().value!)
  return lines
}

export const plainLines = (code: string): Line[] =>
  code.split('\n').map((content) => (content ? [{ content, offset: 0 }] : []))
