/** @jsxImportSource @solidjs/web */
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import { ChevronRight } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { createPatch } from 'diff'
import { createMemo, For, Match, Show, Switch } from 'solid-js'
import { ToolImage } from '@/components/ai/tool.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import {
  cn,
  fillComposer,
  focusComposer,
  formatTokens,
  keepLast,
  plural,
  useAction,
  useAgent,
  useConversationId,
  useConversationSummary,
  useSystem,
  useTranscript,
} from '@/sdk/solid'
import { Diff, parsePatch } from '../coding-tools/ui.solid.tsx'
import { DefinitionAction } from '../subagents/refs.ts'
import { AgentMark } from '../conversations/ui.solid.tsx'
import { modelLine } from './breakdown.ts'
import type { Breakdown, Diff as ContextDiff, Section, Tool } from './breakdown.ts'

export const signed = (delta: number) =>
  delta === 0 ? '±0' : `${delta > 0 ? '+' : '−'}${formatTokens(Math.abs(delta))}`
export const changeCounts = (diff: ContextDiff) =>
  [
    diff.sections.length && plural(diff.sections.length, 'section'),
    diff.tools.length && plural(diff.tools.length, 'tool'),
  ]
    .filter(Boolean)
    .join(' · ')
const percent = (part: number, total: number) =>
  total > 0 ? `${Math.max(part > 0 ? 1 : 0, Math.round((part / total) * 100))}%` : ''

const tones = {
  prompt: 'bg-brand/70',
  tools: 'bg-brand/35',
  injected: 'bg-muted-foreground/45',
} as const
const parts = ['prompt', 'tools', 'injected'] as const

function useIdentity() {
  const summary = useConversationSummary(useConversationId())
  const standing = () => {
    const title = summary()?.title
    return title?.startsWith('@') ? title.slice(1) : undefined
  }
  return {
    name: () => (standing() ? `@${standing()}` : (summary()?.label ?? 'agent')),
    mark: () => standing() ?? (summary()?.label === 'lander' ? 'lander' : 'agent'),
    definition: () => {
      const label = summary()?.label
      return standing() ?? (label === 'agent' ? undefined : label)
    },
  }
}

type Tokens = Breakdown['tokens']
function BudgetBar(props: { tokens: Tokens; class?: string }) {
  return (
    <span
      aria-hidden="true"
      class={cn('flex h-1 overflow-hidden rounded-full bg-muted', props.class)}
      data-context-bar
    >
      <For each={parts}>
        {(part) => (
          <Show when={props.tokens[part] > 0}>
            <span
              class={tones[part]}
              style={{ width: `${(props.tokens[part] / props.tokens.total) * 100}%` }}
            />
          </Show>
        )}
      </For>
    </span>
  )
}

function PartHeading(props: {
  tone?: string
  title: string
  count?: string
  tokens: number
  total: number
}) {
  return (
    <div class="flex items-baseline gap-2 px-3 pt-3 pb-1">
      <Show when={props.tone}>
        <span class={cn('size-2 shrink-0 translate-y-[-1px] rounded-[2px]', props.tone)} />
      </Show>
      <span class="section-label">{props.title}</span>
      <Show when={props.count}>
        <span class="text-muted-foreground/70">{props.count}</span>
      </Show>
      <span class="ml-auto text-foreground/85 tabular-nums">{formatTokens(props.tokens)}</span>
      <span class="w-9 text-right text-muted-foreground/70 tabular-nums">
        {percent(props.tokens, props.total)}
      </span>
    </div>
  )
}

function Row(props: {
  label: string
  name: JSX.Element
  hint?: string
  amount: string
  meter?: { share: number; tone: string }
  children: JSX.Element
}) {
  return (
    <Collapsible class="group/row">
      <CollapsibleTrigger
        aria-label={props.label}
        class="flex h-6 w-full items-center gap-2 rounded-sm px-3 text-left hover:bg-accent/50"
      >
        <ChevronRight class="size-3 shrink-0 text-muted-foreground/60 transition-transform group-data-open/row:rotate-90" />
        <span class="w-44 shrink-0 truncate text-foreground/85 max-sm:w-auto max-sm:min-w-0 max-sm:flex-1">
          {props.name}
        </span>
        <span class="min-w-0 flex-1 truncate text-muted-foreground/70 max-sm:hidden">
          {props.hint}
        </span>
        <Show when={props.meter}>
          {(meter) => (
            <span class="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted max-sm:hidden">
              <span
                class={cn('block h-full', meter().tone)}
                style={{ width: `${Math.max(2, meter().share * 100)}%` }}
              />
            </span>
          )}
        </Show>
        <span class="w-12 shrink-0 text-right text-muted-foreground tabular-nums">
          {props.amount}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent class="pt-1 pr-3 pb-2 pl-8">{props.children}</CollapsibleContent>
    </Collapsible>
  )
}

function Text(props: { text: string }) {
  return (
    <pre class="max-h-96 overflow-auto rounded-sm bg-terminal px-2.5 py-2 text-[11.5px] leading-[1.55] break-words whitespace-pre-wrap text-foreground/85">
      {props.text}
    </pre>
  )
}

function ToolBody(props: { tool: Tool }) {
  return (
    <div class="flex flex-col gap-2">
      <p class="font-sans text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-foreground/85">
        {props.tool.description}
      </p>
      <Text text={JSON.stringify(props.tool.parameters, null, 2)} />
    </div>
  )
}

const unwrapSectionTags = (section: { key: string; text: string }) => {
  const open = `<${section.key}>\n`
  const close = `\n</${section.key}>`
  return section.text.startsWith(open) && section.text.endsWith(close)
    ? section.text.slice(open.length, -close.length)
    : section.text
}
const firstLine = (text: string) =>
  text
    .split('\n')
    .map((line) => line.replace(/^[#>*\-\s]+/, '').trim())
    .find((line) => line && !line.startsWith('<')) ?? ''

function Injected(props: { content: string | readonly (TextContent | ImageContent)[] }) {
  const blocks = createMemo(() =>
    typeof props.content === 'string'
      ? [{ type: 'text', text: props.content } as const]
      : props.content,
  )
  return (
    <div class="flex flex-col gap-2">
      <For each={blocks()}>
        {(block, index) =>
          block.type === 'text' ? (
            <Text text={block.text} />
          ) : (
            <ToolImage alt={`Injected image ${index() + 1}`} image={block} />
          )
        }
      </For>
    </div>
  )
}

const unescapeXml = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

function promptSkills(sections: readonly Section[]) {
  const text = sections.find((section) => section.key === 'skills')?.text ?? ''
  return [...text.matchAll(/<skill>([\s\S]*?)<\/skill>/g)].map(([, body]) => {
    const field = (tag: string) =>
      unescapeXml(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body)?.[1] ?? '')
    return { name: field('name'), description: field('description'), path: field('location') }
  })
}

function useReadPaths() {
  const entries = useTranscript()
  return createMemo(() => {
    const paths = new Set<string>()
    for (const entry of entries()) {
      for (const message of entry.model ?? []) {
        if (message.role !== 'assistant') continue
        for (const block of message.content) {
          if (
            block.type === 'toolCall' &&
            block.name === 'read' &&
            typeof block.arguments.path === 'string'
          )
            paths.add(block.arguments.path)
        }
      }
    }
    return paths
  })
}

function SkillPills(props: { breakdown: Breakdown; allowed?: readonly string[]; label: string }) {
  const id = useConversationId()
  const read = useReadPaths()
  const skills = createMemo(() => promptSkills(props.breakdown.prompt?.sections ?? []))
  const unknown = () =>
    (props.allowed ?? []).filter((name) => !skills().some((skill) => skill.name === name))
  return (
    <Show when={skills().length || props.allowed}>
      <span class="text-muted-foreground/70">skills</span>
      <span class="flex min-w-0 flex-col gap-1" data-ui="agent-skills">
        <span class="flex flex-wrap gap-1">
          <For each={skills()} keyed={(skill) => skill.name}>
            {(skill) => (
              <Button
                aria-label={`Run skill ${skill().name} (${props.label})`}
                class={cn(
                  'rounded-sm border px-1.5 text-[11px] leading-5 transition-colors hover:bg-accent/60',
                  read().has(skill().path)
                    ? 'border-brand/40 bg-brand/10 text-brand'
                    : 'border-border/80 text-foreground/80',
                )}
                onClick={() => {
                  const conversation = id()
                  if (conversation === undefined) return
                  fillComposer(conversation, `/skill:${skill().name} `)
                  focusComposer()
                }}
                size={null}
                title={`${skill().description}\n${skill().path}\n\nClick to run /skill:${skill().name}`}
                variant={null}
              >
                {skill().name}
              </Button>
            )}
          </For>
          <For each={unknown()}>
            {(name) => (
              <span
                class="rounded-sm border border-dashed border-error/50 px-1.5 text-[11px] leading-5 text-error/90 line-through decoration-error/50"
                title={`No skill named ${name}: the definition lists it, but no skill folder provides it`}
              >
                {name}
              </span>
            )}
          </For>
        </span>
        <span class="font-sans text-[11.5px] leading-snug text-muted-foreground/70">
          {props.allowed
            ? `Limited by its definition to ${plural(props.allowed.length, 'skill')}. `
            : 'All project skills. '}
          Highlighted ones were read here; click one to run it.
        </span>
      </span>
    </Show>
  )
}

function Definition(props: { name: string; breakdown: Breakdown; label: string }) {
  const system = useSystem()
  const { data } = useAction(
    DefinitionAction,
    {
      get name() {
        return props.name
      },
    },
    { onError: keepLast },
  )
  const path = () => {
    const definition = data()
    const root = system()?.code.ultimateRoot
    return (
      definition &&
      (root && definition.path.startsWith(root)
        ? definition.path.slice(root.length + 1)
        : definition.path.replace(system()?.machine.home ?? '\0', '~'))
    )
  }
  return (
    <>
      <Show when={path()}>
        <span class="text-muted-foreground/70">definition</span>
        <span class="min-w-0">
          <span class="break-all text-foreground/85">{path()}</span>
          <span class="text-muted-foreground/70"> · current file</span>
          <Show when={data()?.definition?.description}>
            <span class="mt-0.5 block font-sans text-[12.5px] leading-snug text-muted-foreground">
              {data()?.definition?.description}
            </span>
          </Show>
          <span class="mt-0.5 block font-sans text-[11.5px] leading-snug text-muted-foreground/70">
            What it ran with is the instructions section below.
          </span>
        </span>
      </Show>
      <SkillPills
        allowed={data()?.definition?.skills}
        breakdown={props.breakdown}
        label={props.label}
      />
    </>
  )
}

function AgentPart(props: { breakdown: Breakdown; label: string }) {
  const identity = useIdentity()
  const agent = useAgent()
  const model = createMemo(() => modelLine(props.breakdown.model, agent()))
  return (
    <div class="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 px-3 pt-3">
      <span class="text-muted-foreground/70">agent</span>
      <span class="text-foreground/90">{identity.name()}</span>
      <span class="text-muted-foreground/70">model</span>
      <span class="truncate text-foreground/90">
        <Show when={model()} fallback="none configured">
          {(shown) => (
            <>
              {shown().text}
              <Show when={shown().configured}>
                <span class="text-muted-foreground/70"> (configured)</span>
              </Show>
            </>
          )}
        </Show>
      </span>
      <Show
        when={identity.definition()}
        fallback={<SkillPills breakdown={props.breakdown} label={props.label} />}
      >
        {(name) => <Definition breakdown={props.breakdown} label={props.label} name={name()} />}
      </Show>
    </div>
  )
}

export function Header(props: {
  breakdown: Breakdown
  label: string
  notice?: string
  changes?: JSX.Element
  class?: string
  bodyClassName?: string
}) {
  const identity = useIdentity()
  const tokens = () => props.breakdown.tokens
  const sections = () => props.breakdown.prompt?.sections ?? []
  const tools = () => props.breakdown.prompt?.tools ?? []
  const largest = createMemo(() =>
    Math.max(1, ...sections().map((s) => s.tokens), ...tools().map((t) => t.tokens)),
  )
  const skills = createMemo(() => promptSkills(sections()).length)
  const meter = (count: number, part: keyof typeof tones) => ({
    share: count / largest(),
    tone: tones[part],
  })
  return (
    <Collapsible
      class={cn(
        'group/context @container rounded-md border border-border/70 bg-card/40 font-mono text-[11.5px]',
        props.class,
      )}
      data-context-header={props.breakdown.start?.id ?? 'start'}
      data-ui="turn-header"
    >
      <CollapsibleTrigger
        aria-label={`Toggle ${props.label}`}
        class="flex h-8 w-full items-center gap-2 px-2.5 text-left text-muted-foreground transition-colors hover:bg-accent/40"
      >
        <ChevronRight class="size-3 shrink-0 text-muted-foreground/70 transition-transform group-data-open/context:rotate-90" />
        <AgentMark name={identity.mark()} />
        <span class="truncate text-foreground/90">{identity.name()}</span>
        <Show when={props.breakdown.model?.model}>
          <span class="min-w-0 flex-1 truncate">
            · {props.breakdown.model?.model}
            {props.breakdown.model?.thinking && ` · ${props.breakdown.model.thinking}`}
          </span>
        </Show>
        <span class="ml-auto flex min-w-0 items-center gap-2.5 pl-2">
          <Show when={props.notice}>
            <span class="min-w-0 truncate text-brand" data-pinned-notice>
              {props.notice}
            </span>
          </Show>
          <span
            class={cn(
              'shrink-0 max-sm:hidden @max-xl:hidden',
              props.notice && 'max-lg:hidden @max-2xl:hidden',
            )}
          >
            {`${sections().length} sections · ${tools().length} tools · ${plural(skills(), 'skill')}`}
            {props.breakdown.injected && ` · ${props.breakdown.injected.label.split(' · ')[0]}`}
          </span>
          <BudgetBar tokens={tokens()} class="w-20 min-w-6 shrink-[100] max-sm:w-12" />
          <span class="shrink-0 text-foreground/85 tabular-nums">
            {formatTokens(tokens().total)}
          </span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent class={cn('border-t border-border/70 pb-2', props.bodyClassName)}>
        {props.changes}
        <AgentPart breakdown={props.breakdown} label={props.label} />
        <PartHeading
          count={`${sections().length} sections`}
          title="System prompt"
          tokens={tokens().prompt}
          tone={tones.prompt}
          total={tokens().total}
        />
        <For each={sections()} keyed={(section) => section.key}>
          {(section) => (
            <Row
              amount={formatTokens(section().tokens)}
              hint={firstLine(unwrapSectionTags(section()))}
              label={`Section ${section().key} (${props.label})`}
              meter={meter(section().tokens, 'prompt')}
              name={section().key}
            >
              <Text text={unwrapSectionTags(section())} />
            </Row>
          )}
        </For>
        <PartHeading
          count={`${tools().length} tools`}
          title="Tools"
          tokens={tokens().tools}
          tone={tones.tools}
          total={tokens().total}
        />
        <For each={tools()} keyed={(tool) => tool.name}>
          {(tool) => (
            <Row
              amount={formatTokens(tool().tokens)}
              hint={tool().description.split('\n')[0]}
              label={`Tool ${tool().name} (${props.label})`}
              meter={meter(tool().tokens, 'tools')}
              name={tool().name}
            >
              <ToolBody tool={tool()} />
            </Row>
          )}
        </For>
        <Show when={props.breakdown.injected}>
          {(injected) => (
            <>
              <PartHeading
                title="Injected context"
                tokens={tokens().injected}
                tone={tones.injected}
                total={tokens().total}
              />
              <Row
                amount={formatTokens(injected().tokens)}
                hint="before the first input"
                label={`Injected context (${props.label})`}
                meter={meter(injected().tokens, 'injected')}
                name={injected().label}
              >
                <Injected content={injected().content} />
              </Row>
            </>
          )}
        </Show>
        <p class="px-3 pt-2 font-sans text-[11.5px] text-muted-foreground/70">
          Estimates at 3.5 characters per token; an image counts as about 1.4k.
        </p>
      </CollapsibleContent>
    </Collapsible>
  )
}

const marks = { added: '+', changed: '~', removed: '−' } as const
const changeTone = { added: 'text-success', changed: 'text-brand', removed: 'text-error' } as const
function ChangeName(props: { change: keyof typeof marks; name: string }) {
  return (
    <>
      <span class={changeTone[props.change]}>{marks[props.change]}</span> {props.name}
    </>
  )
}

function sectionRows(section: ContextDiff['sections'][number]) {
  const before = unwrapSectionTags({ key: section.key, text: section.before ?? '' })
  const after = unwrapSectionTags(section)
  return parsePatch(createPatch('section', before, after, '', '', { context: 3 }))
}

export function DiffBody(props: { diff: ContextDiff; label: string }) {
  const sections = () => props.diff.sections
  const tools = () => props.diff.tools
  return (
    <Show
      when={sections().length || tools().length}
      fallback={<div class="px-3 py-2 text-muted-foreground">Nothing the model sees changed.</div>}
    >
      <div class="py-1.5">
        <For each={sections()} keyed={(section) => section.key}>
          {(section) => (
            <Row
              amount={signed(section().delta)}
              hint={section().change}
              label={`Section change ${section().key} (${props.label})`}
              name={<ChangeName change={section().change} name={section().key} />}
            >
              <Switch>
                <Match when={section().before === undefined}>
                  <Text text={unwrapSectionTags(section())} />
                </Match>
                <Match when={true}>
                  <Diff class="max-h-96 rounded-sm text-[11.5px]" rows={sectionRows(section())} />
                </Match>
              </Switch>
            </Row>
          )}
        </For>
        <For each={tools()} keyed={(tool) => tool.name}>
          {(tool) => (
            <Row
              amount={signed(tool().delta)}
              hint={`tool ${tool().change}`}
              label={`Tool change ${tool().name} (${props.label})`}
              name={<ChangeName change={tool().change} name={tool().name} />}
            >
              <ToolBody tool={tool().tool} />
            </Row>
          )}
        </For>
        <div class="flex px-3 pt-1 text-muted-foreground">
          <span>{`${plural(sections().length, 'section')} · ${plural(tools().length, 'tool')}`}</span>
          <span class="ml-auto text-foreground/85 tabular-nums">
            {signed(props.diff.delta)} tokens
          </span>
        </div>
      </div>
    </Show>
  )
}
