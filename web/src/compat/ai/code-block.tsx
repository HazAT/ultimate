import { cn } from 'cn'
import type { CSSProperties, HTMLAttributes, Ref } from 'react'
import { memo, useState } from 'react'
import { highlight, plainLines } from '../../components/markdown/highlight.ts'
import type { Line } from '../../components/markdown/highlight.ts'

export { languageFromPath } from '../../components/markdown/highlight.ts'

function useLines(code: string, language: string): Line[] {
  const [loaded, setLoaded] = useState<{ code: string; language: string; lines: Line[] }>()
  if (loaded?.code === code && loaded.language === language) return loaded.lines
  return (
    highlight(code, language, (lines) => setLoaded({ code, language, lines })) ?? plainLines(code)
  )
}

export type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string
  language: string
  showLineNumbers?: boolean
  startLine?: number
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
    const tokens = useLines(code.replace(/\n$/, ''), language)
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
                      <span key={i} style={token.htmlStyle as CSSProperties}>
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
