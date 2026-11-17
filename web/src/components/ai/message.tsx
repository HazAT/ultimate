import { cn } from 'cn'
import type { ComponentProps, HTMLAttributes, ReactNode } from 'react'
import { memo, useMemo } from 'react'
import {
  CodeBlock,
  CodeBlockCopyButton,
  defaultComponents,
  defaultRemarkPlugins,
  Streamdown,
} from 'streamdown'
import type { CustomRendererProps, ExtraProps } from 'streamdown'
import { ExtensionBoundary } from '../../app/boundary.tsx'
import { useExtensions } from '../../sdk/hooks.ts'
import {
  codeBlockLanguages,
  codeBlockRenderers,
  inlineCodeRenderers,
  linkRenderers,
} from '../../sdk/registry.ts'
import { codePlugin } from './code-block.tsx'
import { mentionHref, parseMention, remarkMentions, splitMentions } from './mentions.ts'

export type MessageProps = HTMLAttributes<HTMLDivElement> & { from: 'user' | 'assistant' }

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      'group flex w-full flex-col gap-2',
      from === 'user' ? 'is-user' : 'is-assistant',
      className,
    )}
    data-from={from}
    {...props}
  />
)

export const MessageContent = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex min-w-0 max-w-full flex-col gap-2 text-[14px] leading-relaxed',
      'group-[.is-user]:rounded-lg group-[.is-user]:border group-[.is-user]:border-border/70 group-[.is-user]:bg-secondary/60 group-[.is-user]:px-3.5 group-[.is-user]:py-2.5',
      className,
    )}
    {...props}
  />
)

const CoreLink = defaultComponents.a
function Link(props: ComponentProps<'a'> & ExtraProps) {
  const renderers = linkRenderers(useExtensions())
  const { href, children } = props
  const mentionWithoutRendererStaysText = href && parseMention(href)
  const core = mentionWithoutRendererStaysText ? <>{children}</> : <CoreLink {...props} />
  const incompleteStreamingLink = !href || href === 'streamdown:incomplete-link'
  if (incompleteStreamingLink) return core
  return renderers.reduce<ReactNode>(
    (inner, { extension, version, component: Renderer }) => (
      <ExtensionBoundary
        extension={extension}
        fallback={inner}
        key={extension}
        variant="inline"
        version={version}
      >
        <Renderer core={inner} href={href}>
          {children}
        </Renderer>
      </ExtensionBoundary>
    ),
    core,
  )
}

export function MentionText({ text }: { text: string }) {
  return splitMentions(text).map((part, index) =>
    typeof part === 'string' ? (
      part
    ) : (
      <Link href={mentionHref(part.conversation, part.entry)} key={index}>
        {part.text}
      </Link>
    ),
  )
}

const CoreCode = defaultComponents.code
function InlineCode(props: ComponentProps<'code'> & ExtraProps) {
  const renderers = inlineCodeRenderers(useExtensions())
  const { children } = props
  const core = <CoreCode {...props} />
  if (typeof children !== 'string') return core
  return renderers.reduce<ReactNode>(
    (inner, { extension, version, component: Renderer }) => (
      <ExtensionBoundary
        extension={extension}
        fallback={inner}
        key={extension}
        variant="inline"
        version={version}
      >
        <Renderer code={children} core={inner} />
      </ExtensionBoundary>
    ),
    core,
  )
}

const components = { a: Link, inlineCode: InlineCode }
const gfmBeforeMentionsKeepsUrlFragments = [...Object.values(defaultRemarkPlugins), remarkMentions]

function ExtensionCodeBlock({ code, language, isIncomplete }: CustomRendererProps) {
  const renderers = codeBlockRenderers(useExtensions(), language)
  const core = (
    <CodeBlock code={code} isIncomplete={isIncomplete} language={language} lineNumbers={false}>
      <CodeBlockCopyButton />
    </CodeBlock>
  )
  return renderers.reduce<ReactNode>(
    (inner, { extension, version, component: Renderer }) => (
      <ExtensionBoundary extension={extension} fallback={inner} key={extension} version={version}>
        <Renderer code={code} core={inner} incomplete={isIncomplete} language={language} />
      </ExtensionBoundary>
    ),
    core,
  )
}
const controls = { code: { copy: true, download: false }, table: false, mermaid: false } as const

export const MessageResponse = memo(
  ({ className, ...props }: ComponentProps<typeof Streamdown>) => {
    const languages = codeBlockLanguages(useExtensions()).join(' ')
    const plugins = useMemo(
      () => ({
        code: codePlugin,
        renderers: languages
          ? [{ language: languages.split(' '), component: ExtensionCodeBlock }]
          : [],
      }),
      [languages],
    )
    return (
      <Streamdown
        className={cn('markdown min-w-0', className)}
        components={components}
        controls={controls}
        lineNumbers={false}
        plugins={plugins}
        remarkPlugins={gfmBeforeMentionsKeepsUrlFragments}
        shikiTheme={codePlugin.getThemes()}
        tableMaxHeight="none"
        {...props}
      />
    )
  },
  (previous, next) =>
    previous.children === next.children && previous.isAnimating === next.isAnimating,
)
MessageResponse.displayName = 'MessageResponse'
