/** The pieces of the context breakdown: its header card, its rows and the diff of a prompt change. */
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import { createPatch } from 'diff'
import { ChevronRightIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ToolImage } from '@/components/ai/tool'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  cn,
  formatTokens,
  useAction,
  useConversation,
  useConversationSummary,
  useSystem,
} from '@/sdk'
import { Diff, parsePatch } from '../coding-tools/ui.tsx'
import { AgentMark } from '../conversations/ui.tsx'
import { DefinitionAction } from '../subagents/ui.tsx'
import { modelLine } from './breakdown.ts'
import type { Breakdown, Diff as PromptDiff, Section, Tool } from './breakdown.ts'

export const signed = (delta: number) =>
  delta === 0 ? '±0' : `${delta > 0 ? '+' : '−'}${formatTokens(Math.abs(delta))}`
const percent = (part: number, total: number) =>
  total > 0 ? `${Math.max(part > 0 ? 1 : 0, Math.round((part / total) * 100))}%` : ''

/** The parts of the budget, in request order, with their tint in the bar and legend. */
const tones = {
  prompt: 'bg-brand/70',
  tools: 'bg-brand/35',
  injected: 'bg-muted-foreground/45',
} as const

/** Who the shown conversation is: a standing agent's @name, or its label (the definition it runs, or `branch`). */
function useIdentity() {
  const id = useConversation((conversation) => conversation.id)
  const summary = useConversationSummary(id)
  const standing = summary?.title?.startsWith('@') ? summary.title.slice(1) : undefined
  const label = summary?.label
  // A standing agent runs the definition of its name; a branch the coordinator's.
  const definition = standing ?? (label && label !== 'agent' ? label : undefined)
  return {
    name: standing ? `@${standing}` : (label ?? 'agent'),
    mark: standing ?? (label === 'lander' ? 'lander' : 'agent'),
    definition,
  }
}

/** A thin bar of the budget's parts, each as wide as its share. */
function BudgetBar({ breakdown, className }: { breakdown: Breakdown; className?: string }) {
  const { tokens } = breakdown
  return (
    <span
      aria-hidden
      className={cn('flex h-1 overflow-hidden rounded-full bg-muted', className)}
      data-context-bar
    >
      {(['prompt', 'tools', 'injected'] as const).map((part) =>
        tokens[part] > 0 ? (
          <span
            className={tones[part]}
            key={part}
            style={{ width: `${(tokens[part] / tokens.total) * 100}%` }}
          />
        ) : null,
      )}
    </span>
  )
}

/** One part's heading inside the expanded breakdown: its swatch, name, count, tokens and share of the total. */
function PartHeading({
  tone,
  title,
  count,
  tokens,
  total,
}: {
  tone?: string
  title: string
  count?: string
  tokens: number
  total: number
}) {
  return (
    <div className="flex items-baseline gap-2 px-3 pt-3 pb-1">
      {tone && <span className={cn('size-2 shrink-0 translate-y-[-1px] rounded-[2px]', tone)} />}
      <span className="section-label">{title}</span>
      {count && <span className="text-muted-foreground">{count}</span>}
      <span className="ml-auto text-foreground/85 tabular-nums">{formatTokens(tokens)}</span>
      <span className="w-9 text-right text-muted-foreground tabular-nums">
        {percent(tokens, total)}
      </span>
    </div>
  )
}

/** A row that opens to its full text: a section, a tool, an injected message. */
function Row({
  name,
  hint,
  tokens,
  total,
  sign,
  tone,
  children,
}: {
  name: ReactNode
  hint?: string
  tokens: number
  /** Scales the row's bar; none without it. */
  total?: number
  /** Shown instead of the tokens, such as a diff's delta. */
  sign?: ReactNode
  tone?: string
  children: ReactNode
}) {
  return (
    <Collapsible className="group/row">
      <CollapsibleTrigger className="flex h-6 w-full cursor-pointer items-center gap-2 rounded-sm px-3 text-left hover:bg-accent/50">
        <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/row:rotate-90" />
        <span className="w-44 shrink-0 truncate text-foreground/85 max-sm:w-auto max-sm:min-w-0 max-sm:flex-1">
          {name}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground max-sm:hidden">{hint}</span>
        {total !== undefined && (
          <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted max-sm:hidden">
            <span
              className={cn('block h-full', tone)}
              style={{ width: `${Math.max(2, (tokens / total) * 100)}%` }}
            />
          </span>
        )}
        <span className="w-12 shrink-0 text-right text-muted-foreground tabular-nums">
          {sign ?? formatTokens(tokens)}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1 pr-3 pb-2 pl-8">{children}</CollapsibleContent>
    </Collapsible>
  )
}

function Text({ text }: { text: string }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-sm bg-terminal px-2.5 py-2 text-[0.7188rem] leading-[1.55] break-words whitespace-pre-wrap text-foreground/85">
      {text}
    </pre>
  )
}

function ToolBody({ tool }: { tool: Tool }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="font-sans text-[0.7812rem] leading-relaxed break-words whitespace-pre-wrap text-foreground/85">
        {tool.description}
      </p>
      <Text text={JSON.stringify(tool.parameters, null, 2)} />
    </div>
  )
}

/** A section's text without the `<key>` tags Pi Durable wraps it in, which its name already says. */
const unwrap = (section: { key: string; text: string }) => {
  const open = `<${section.key}>\n`
  const close = `\n</${section.key}>`
  return section.text.startsWith(open) && section.text.endsWith(close)
    ? section.text.slice(open.length, -close.length)
    : section.text
}
/** A section's first line of prose, as the row's hint. */
const firstLine = (text: string) =>
  text
    .split('\n')
    .map((line) => line.replace(/^[#>*\-\s]+/, '').trim())
    .find((line) => line && !line.startsWith('<')) ?? ''

function Injected({ content }: { content: string | readonly (TextContent | ImageContent)[] }) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content } as const] : content
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, index) =>
        block.type === 'text' ? (
          // oxlint-disable-next-line react/no-array-index-key -- Fixed injected content blocks are positional.
          <Text key={index} text={block.text} />
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- Fixed injected content blocks are positional.
          <ToolImage alt={`Injected image ${index + 1}`} image={block} key={index} />
        ),
      )}
    </div>
  )
}

/** The agent, its definition and the model the context ran on. */
function AgentPart({ breakdown }: { breakdown: Breakdown }) {
  const identity = useIdentity()
  const agent = useConversation((conversation) => conversation.agent)
  const system = useSystem()
  const shown = useAction(
    DefinitionAction,
    { name: identity.definition ?? '' },
    // A label that names no definition, such as `branch`, simply has none to show.
    { enabled: !!identity.definition, onError: () => {} },
  )
  const definition = shown.data?.definition
  const model = modelLine(breakdown.model, agent)
  const path =
    shown.data &&
    (shown.data.path.startsWith(system?.code.ultimateRoot ?? '\0')
      ? shown.data.path.slice((system?.code.ultimateRoot.length ?? 0) + 1)
      : shown.data.path.replace(system?.machine.home ?? '\0', '~'))
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 px-3 pt-3">
      <span className="text-muted-foreground">agent</span>
      <span className="text-foreground/90">{identity.name}</span>
      <span className="text-muted-foreground">model</span>
      <span className="truncate text-foreground/90">
        {model ? (
          <>
            {model.text}
            {model.configured && <span className="text-muted-foreground"> (configured)</span>}
          </>
        ) : (
          'none configured'
        )}
      </span>
      {path && (
        <>
          <span className="text-muted-foreground">definition</span>
          <span className="min-w-0">
            <span className="break-all text-foreground/85">{path}</span>
            <span className="text-muted-foreground"> · current file</span>
            {definition?.description && (
              <span className="mt-0.5 block font-sans text-[0.7812rem] leading-snug text-muted-foreground">
                {definition.description}
              </span>
            )}
            <span className="mt-0.5 block font-sans text-[0.7188rem] leading-snug text-muted-foreground">
              What it ran with is the instructions section below.
            </span>
          </span>
        </>
      )}
    </div>
  )
}

/**
 * What the model saw before the first input of a context: one quiet line with the agent, its model and the budget,
 * opening to the agent, the system prompt by section, the tools and the injected context, each with its tokens. The
 * pinned prompt adds a `notice` to its line, `changes` above its parts, and its own look through `className`s.
 */
export function Header({
  breakdown,
  notice,
  changes,
  className,
  bodyClassName,
}: {
  breakdown: Breakdown
  notice?: ReactNode
  changes?: ReactNode
  className?: string
  bodyClassName?: string
}) {
  const identity = useIdentity()
  const [open, setOpen] = useState(false)
  const { tokens, prompt } = breakdown
  const sections = prompt?.sections ?? []
  const tools = prompt?.tools ?? []
  const largest = Math.max(1, ...sections.map((s) => s.tokens), ...tools.map((t) => t.tokens))
  const model = breakdown.model?.model
  return (
    <Collapsible
      className={cn(
        'group/context rounded-md border border-border/70 bg-card/40 font-mono text-[0.7188rem]',
        className,
      )}
      data-context-header={breakdown.start?.id ?? 'start'}
      data-ui="turn-header"
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger className="flex h-8 w-full cursor-pointer items-center gap-2 px-2.5 text-left text-muted-foreground transition-colors hover:bg-accent/40">
        <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/context:rotate-90" />
        <AgentMark name={identity.mark} size="sm" />
        <span className="shrink-0 text-foreground/90">{identity.name}</span>
        {model && (
          <span className="min-w-0 flex-1 truncate">
            · {model}
            {breakdown.model?.thinking && ` · ${breakdown.model.thinking}`}
          </span>
        )}
        <span className="ml-auto flex min-w-0 items-center gap-2.5 pl-2">
          {notice}
          <span className={cn('shrink-0 max-sm:hidden', notice && 'max-lg:hidden')}>
            {sections.length} sections · {tools.length} tools
            {breakdown.injected && ` · ${breakdown.injected.label.split(' · ')[0]}`}
          </span>
          <BudgetBar breakdown={breakdown} className="w-20 min-w-6 shrink-[100] max-sm:w-12" />
          <span className="shrink-0 text-foreground/85 tabular-nums">
            {formatTokens(tokens.total)}
          </span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className={cn('border-t border-border/70 pb-2', bodyClassName)}>
        {open && (
          <>
            {changes}
            <AgentPart breakdown={breakdown} />
            <PartHeading
              count={`${sections.length} sections`}
              title="System prompt"
              tokens={tokens.prompt}
              tone={tones.prompt}
              total={tokens.total}
            />
            {sections.map((section: Section) => (
              <Row
                hint={firstLine(unwrap(section))}
                key={section.key}
                name={section.key}
                tokens={section.tokens}
                tone={tones.prompt}
                total={largest}
              >
                <Text text={unwrap(section)} />
              </Row>
            ))}
            <PartHeading
              count={`${tools.length} tools`}
              title="Tools"
              tokens={tokens.tools}
              tone={tones.tools}
              total={tokens.total}
            />
            {tools.map((tool) => (
              <Row
                hint={tool.description.split('\n')[0]}
                key={tool.name}
                name={tool.name}
                tokens={tool.tokens}
                tone={tones.tools}
                total={largest}
              >
                <ToolBody tool={tool} />
              </Row>
            ))}
            {breakdown.injected && (
              <>
                <PartHeading
                  title="Injected context"
                  tokens={tokens.injected}
                  tone={tones.injected}
                  total={tokens.total}
                />
                <Row
                  hint="before the first input"
                  name={breakdown.injected.label}
                  tokens={breakdown.injected.tokens}
                  tone={tones.injected}
                  total={largest}
                >
                  <Injected content={breakdown.injected.content} />
                </Row>
              </>
            )}
            <p className="px-3 pt-2 font-sans text-[0.7188rem] text-muted-foreground">
              Estimates at 3.5 characters per token; an image counts as about 1.4k.
            </p>
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** A changed section's text as a line diff, three lines of context around each change. */
function SectionDiff({ before, after }: { before: string; after: string }) {
  const rows = useMemo(
    () => parsePatch(createPatch('section', before, after, '', '', { context: 3 })),
    [before, after],
  )
  return <Diff className="max-h-96 rounded-sm text-[0.7188rem]" rows={rows} />
}

/**
 * The section and tool changes of a prompt patch, or since the prompt last acknowledged: each opens to its line diff,
 * or its new (or removed) text.
 */
export function DiffBody({ diff }: { diff: PromptDiff }) {
  const marks = { added: '+', changed: '~', removed: '−' } as const
  const tone = { added: 'text-success', changed: 'text-brand', removed: 'text-error' } as const
  if (diff.sections.length === 0 && diff.tools.length === 0)
    return <div className="px-3 py-2 text-muted-foreground">Nothing the model sees changed.</div>
  return (
    <div className="py-1.5">
      {diff.sections.map((section) => (
        <Row
          key={section.key}
          name={
            <>
              <span className={tone[section.change]}>{marks[section.change]}</span> {section.key}
            </>
          }
          hint={section.change}
          sign={signed(section.delta)}
          tokens={section.delta}
        >
          {section.before === undefined ? (
            <Text text={unwrap(section)} />
          ) : (
            <SectionDiff
              after={unwrap(section)}
              before={unwrap({ key: section.key, text: section.before })}
            />
          )}
        </Row>
      ))}
      {diff.tools.map((tool) => (
        <Row
          hint={`tool ${tool.change}`}
          key={`tool:${tool.name}`}
          name={
            <>
              <span className={tone[tool.change]}>{marks[tool.change]}</span> {tool.name}
            </>
          }
          sign={signed(tool.delta)}
          tokens={tool.delta}
        >
          <ToolBody tool={tool.tool} />
        </Row>
      ))}
      <div className="flex px-3 pt-1 text-muted-foreground">
        <span>
          {diff.sections.length} section{diff.sections.length === 1 ? '' : 's'} ·{' '}
          {diff.tools.length} tool{diff.tools.length === 1 ? '' : 's'}
        </span>
        <span className="ml-auto text-foreground/85 tabular-nums">{signed(diff.delta)} tokens</span>
      </div>
    </div>
  )
}
