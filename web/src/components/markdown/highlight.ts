import { bundledLanguages, bundledLanguagesInfo, createHighlighter } from 'shiki'
import type { GrammarState, HighlighterGeneric, ThemedToken } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

export type Line = ThemedToken[]

const themes = { light: 'vitesse-light', dark: 'vitesse-dark' } as const
const aliases = new Map(
  bundledLanguagesInfo.flatMap((info) => (info.aliases ?? []).map((alias) => [alias, info.id])),
)
const languageOf = (name: string) => {
  const lower = name.trim().toLowerCase()
  const id = aliases.get(lower) ?? lower
  return Object.hasOwn(bundledLanguages, id) ? id : 'text'
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

type Highlighter = HighlighterGeneric<string, string>
let highlighter: Highlighter | undefined
let starting: Promise<Highlighter> | undefined
const loading = new Map<string, Promise<unknown>>()

function load(language: string) {
  starting ??= createHighlighter({
    themes: [themes.light, themes.dark],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }).then((ready) => (highlighter = ready))
  let loaded = loading.get(language)
  if (!loaded) {
    loaded = starting.then((ready) =>
      language === 'text' ? undefined : ready.loadLanguage(language as never),
    )
    loading.set(language, loaded)
  }
  return loaded
}

const ready = (language: string) =>
  highlighter !== undefined &&
  (language === 'text' || highlighter.getLoadedLanguages().includes(language))

const finished = new Map<string, Line[]>()
const finishedLimit = 500
const streaming = new Map<string, { prefix: string; lines: Line[]; state?: GrammarState }>()

function tokenize(ready: Highlighter, code: string, language: string): Line[] {
  const tokens = (text: string, state?: GrammarState) =>
    ready.codeToTokens(text, { lang: language, themes, grammarState: state })
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
  if (!ready(language)) {
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
