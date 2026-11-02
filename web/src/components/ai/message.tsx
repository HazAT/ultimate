// Adapted from vercel/ai-elements packages/elements/src/message.tsx (Apache-2.0, see LICENSE).
// Changes: `from` is a plain role, no branches or actions; the code and Mermaid plugins; denser typography; links go
// through the extensions' `link` renderers.
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
import { useExtensions, useStore } from '../../sdk/hooks.ts'
import { codeBlockLanguages, codeBlockRenderers, linkRenderers } from '../../sdk/registry.ts'
import { codePlugin } from './code-block.tsx'
import { mentionHref, parseMention, remarkMentions, splitMentions } from './mentions.ts'
import { diagramPlugin, MermaidSource } from './mermaid.tsx'

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
/** A link as the `link` renderers compose it, starting with Streamdown's, which asks before opening a new tab. */
function Link(props: ComponentProps<'a'> & ExtraProps) {
  const renderers = linkRenderers(useExtensions())
  const { href, children } = props
  // A `#id` mention stays its text unless a renderer knows the conversation.
  const core = href && parseMention(href) ? <>{children}</> : <CoreLink {...props} />
  // Streamdown marks a link whose Markdown is still streaming.
  if (!href || href === 'streamdown:incomplete-link') return core
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

/**
 * Plain text with its `#id` mentions rendered as Markdown mentions are (conversation chips), for text shown verbatim
 * rather than as Markdown: prompts, abstracts, divergences.
 */
export function MentionText({ text }: { text: string }) {
  return splitMentions(text).map((part, index) =>
    typeof part === 'string' ? (
      part
    ) : (
      // oxlint-disable-next-line react/no-array-index-key -- Mention positions in split text; mentions may repeat.
      <Link href={mentionHref(part.conversation, part.entry)} key={index}>
        {part.text}
      </Link>
    ),
  )
}

const components = { a: Link }
// After GFM, so autolinked URLs are links already and keep their `#fragment`.
const remarkPlugins = [...Object.values(defaultRemarkPlugins), remarkMentions]

/** A fenced code block as the `codeBlocks` renderers of its language compose it, starting with the core block. */
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
const diagramOptions = { errorComponent: MermaidSource }
const controls = {
  code: { copy: true, download: false },
  table: false,
  mermaid: { copy: true, download: false, fullscreen: true, panZoom: false },
} as const

/** Markdown that may still be streaming. */
export const MessageResponse = memo(
  ({ className, ...props }: ComponentProps<typeof Streamdown>) => {
    const languages = codeBlockLanguages(useExtensions()).join(' ')
    const theme = useStore((state) => state.ui.theme)
    // A new diagram plugin renders every diagram again, in the theme's colours.
    const plugins = useMemo(
      () => ({
        code: codePlugin,
        mermaid: diagramPlugin(theme),
        renderers: languages
          ? [{ language: languages.split(' '), component: ExtensionCodeBlock }]
          : [],
      }),
      [languages, theme],
    )
    return (
      <Streamdown
        className={cn('markdown min-w-0', className)}
        components={components}
        controls={controls}
        lineNumbers={false}
        mermaid={diagramOptions}
        plugins={plugins}
        remarkPlugins={remarkPlugins}
        shikiTheme={codePlugin.getThemes()}
        {...props}
      />
    )
  },
  (previous, next) =>
    previous.children === next.children && previous.isAnimating === next.isAnimating,
)
MessageResponse.displayName = 'MessageResponse'
