// Adapted from vercel/ai-elements packages/elements/src/code-block.tsx (Apache-2.0, see LICENSE).
// Changes: highlights through Streamdown's shared Shiki plugin, adds `startLine` and `languageFromPath`, drops the
// language selector, header, and copy button.
import { createCodePlugin } from '@streamdown/code'
import type { HighlightOptions, HighlightResult } from '@streamdown/code'
import { cn } from 'cn'
import type { CSSProperties, HTMLAttributes, Ref } from 'react'
import { memo, useEffect, useState } from 'react'

/** One highlighter for Streamdown and every code block. */
export const codePlugin = createCodePlugin({ themes: ['vitesse-light', 'vitesse-dark'] })
const themes = codePlugin.getThemes()
/** A Shiki language id such as `ts` or `bash`. */
export type BundledLanguage = HighlightOptions['language']

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
/** A Shiki language for a file path, `text` when unknown. */
export function languageFromPath(path: string): BundledLanguage {
  const name = path.split('/').at(-1)?.toLowerCase() ?? ''
  if (name === 'dockerfile') return 'dockerfile'
  if (name === 'makefile') return 'makefile'
  const extension = name.includes('.') ? (name.split('.').at(-1) ?? '') : ''
  const language = extensions[extension] ?? extension
  return (
    codePlugin.supportsLanguage(language as BundledLanguage) ? language : 'text'
  ) as BundledLanguage
}

type Line = HighlightResult['tokens'][number]
const plain = (code: string): Line[] =>
  code.split('\n').map((content) => (content ? [{ content, offset: 0, color: 'inherit' }] : []))

/** Keep the last same-language highlight visible while its replacement is being tokenized. */
function useTokens(code: string, language: BundledLanguage): Line[] {
  const [result, setResult] = useState<{ language: string; tokens: Line[] }>()
  useEffect(() => {
    let cancelled = false
    const update = (highlighted: HighlightResult) => {
      if (!cancelled) setResult({ language, tokens: highlighted.tokens })
    }
    const cached = codePlugin.highlight({ code, language, themes }, update)
    if (cached) update(cached)
    return () => {
      cancelled = true
    }
  }, [code, language])
  return result?.language === language ? result.tokens : plain(code)
}

export type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string
  language: BundledLanguage
  showLineNumbers?: boolean
  /** Number of the first line, for excerpts. */
  startLine?: number
  /** The code is still arriving: a soft cursor ends its last line. */
  caret?: boolean
  ref?: Ref<HTMLDivElement>
}

const CodeBlockContent = memo(
  ({
    code,
    language,
    showLineNumbers = false,
    startLine = 1,
    caret = false,
    className,
  }: Omit<CodeBlockProps, keyof HTMLAttributes<HTMLDivElement>> & { className?: string }) => {
    const tokens = useTokens(code.replace(/\n$/, ''), language)
    const width = String(startLine + tokens.length - 1).length
    return (
      <pre
        className={cn(
          'shiki m-0 overflow-auto px-3 py-2 font-mono text-[12px] leading-[1.6]',
          className,
        )}
      >
        <code className="grid">
          {tokens.map((line, index) => (
            <span className="flex" key={index}>
              {showLineNumbers && (
                <span
                  className="sticky left-0 mr-3 shrink-0 bg-inherit pr-1 text-right text-muted-foreground/50 select-none"
                  style={{ width: `${width + 1}ch` }}
                >
                  {startLine + index}
                </span>
              )}
              <span className="whitespace-pre">
                {line.length === 0 && !(caret && index === tokens.length - 1)
                  ? ' '
                  : line.map((token, i) => (
                      <span
                        key={i}
                        style={{
                          color: token.color,
                          fontStyle: token.fontStyle && token.fontStyle & 1 ? 'italic' : undefined,
                          ...(token.htmlStyle as CSSProperties),
                        }}
                      >
                        {token.content}
                      </span>
                    ))}
                {caret && index === tokens.length - 1 && (
                  <span className="ml-px inline-block h-3.5 w-1.5 animate-pulse-dot bg-brand align-middle" />
                )}
              </span>
            </span>
          ))}
        </code>
      </pre>
    )
  },
)
CodeBlockContent.displayName = 'CodeBlockContent'

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  startLine,
  caret,
  className,
  children,
  ...props
}: CodeBlockProps) => (
  <div
    className={cn('group relative w-full overflow-hidden rounded-md border bg-terminal', className)}
    data-language={language}
    {...props}
  >
    {children}
    <CodeBlockContent
      code={code}
      language={language}
      showLineNumbers={showLineNumbers}
      startLine={startLine}
      caret={caret}
    />
  </div>
)
