import { Check, Copy, ExternalLink } from '@lucide/solid'
import { dynamic } from '@solidjs/web'
import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import { find, html } from 'property-information'
import {
  createMemo,
  createProjection,
  createSignal,
  Errored,
  For,
  Match,
  Show,
  Switch,
} from 'solid-js'
import type { Component } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog.solid.tsx'
import {
  codeBlockRenderers,
  errorMessage,
  ExtensionName,
  inlineCodeRenderers,
  linkRenderers,
  useCopy,
  useExtensions,
} from '../../sdk/hooks.ts'
import type { CodeBlockRenderer, InlineCodeRenderer, LinkRenderer } from '../../sdk/hooks.ts'
import { highlight, plainLines } from './highlight.ts'
import type { Line } from './highlight.ts'
import {
  blockSplitterKeepingFinishedBlocks,
  closeUnfinished,
  incompleteLink,
  parse,
} from './parse.ts'
import type { Element, ElementContent } from './parse.ts'
import { mentionHref, parseMention, splitMentions } from '../ai/mentions.ts'

type Rendered = { extension: string; version: number; component: Component<never> }

function Contributed<P extends { core: JSX.Element }>(props: {
  renderers: Rendered[]
  props: Omit<P, 'core'>
  core: () => JSX.Element
}) {
  const wrap = (index: number): JSX.Element => {
    if (index < 0) return props.core()
    const { extension, component } = props.renderers[index]
    const Renderer = component as Component<P>
    return (
      <Errored
        fallback={(error) => (
          <ContributionError extension={extension} error={error()} inner={wrap(index - 1)} />
        )}
      >
        <ExtensionName value={extension}>
          <Renderer {...(props.props as P)} core={wrap(index - 1)} />
        </ExtensionName>
      </Errored>
    )
  }
  return <>{wrap(props.renderers.length - 1)}</>
}

function ContributionError(props: { extension: string; error: unknown; inner: JSX.Element }) {
  return (
    <>
      <span
        class="inline-flex max-w-72 items-center gap-1 rounded-sm bg-error/12 px-1.5 font-mono text-[11px] text-error"
        data-extension-error={props.extension}
        title={errorMessage(props.error)}
      >
        <span class="truncate">
          {props.extension}: {errorMessage(props.error)}
        </span>
      </span>
      {props.inner}
    </>
  )
}

function Anchor(props: {
  href: string
  at?: string
  text?: string
  children: JSX.Element
  attributes: Record<string, unknown>
}) {
  const renderers = createMemo(() => linkRenderers(useExtensions()()) as Rendered[])
  const core = () =>
    parseMention(props.href) ? (
      props.children
    ) : (
      <ConfirmedLink
        at={props.at}
        attributes={props.attributes}
        href={props.href}
        text={props.text ?? ''}
      >
        {props.children}
      </ConfirmedLink>
    )
  return (
    <Show when={props.href !== incompleteLink} fallback={props.children}>
      <Contributed<Parameters<LinkRenderer>[0]>
        core={core}
        props={{ href: props.href, children: props.children }}
        renderers={renderers()}
      />
    </Show>
  )
}

function ConfirmedLink(props: {
  href: string
  at?: string
  text: string
  children: JSX.Element
  attributes: Record<string, unknown>
}) {
  const [open, setOpen] = createSignal(false)
  const { copied, copy } = useCopy()
  return (
    <Show
      when={!props.href.startsWith('#')}
      fallback={
        <a {...props.attributes} href={props.href}>
          {props.children}
        </a>
      }
    >
      <Button
        {...omitHref(props.attributes)}
        aria-label={`Open link ${props.text} (${props.at ?? ''}: ${props.href})`}
        class="link inline h-auto rounded-none p-0 align-baseline text-[length:inherit] [font-weight:inherit] whitespace-normal"
        data-href={props.href}
        onClick={() => setOpen(true)}
        size={null}
        variant={null}
      >
        {props.children}
      </Button>
      <Dialog onOpenChange={setOpen} open={open()}>
        <DialogContent class="gap-0 overflow-hidden p-0 sm:max-w-md">
          <div class="px-4 pt-4 pb-3">
            <DialogTitle class="flex items-center gap-2 text-[14px] font-medium">
              <ExternalLink aria-hidden="true" class="size-4" />
              Open external link?
            </DialogTitle>
            <DialogDescription class="mt-1 text-[13px]">
              You're about to visit an external website.
            </DialogDescription>
            <div class="mt-2 max-h-32 overflow-y-auto rounded-md bg-muted px-2.5 py-1.5 font-mono text-[12px] break-all">
              {props.href}
            </div>
          </div>
          <div class="flex justify-end gap-2 border-t border-border/70 bg-sidebar px-4 py-2">
            <Button onClick={() => copy(props.href)} size="sm" variant="ghost">
              {copied() ? 'Copied' : 'Copy link'}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                window.open(props.href, '_blank', 'noreferrer')
                setOpen(false)
              }}
            >
              Open link
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Show>
  )
}

const omitHref = (attributes: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(attributes).filter(([name]) => name !== 'href'))

function InlineCode(props: { code: string; attributes: Record<string, unknown> }) {
  const renderers = createMemo(() => inlineCodeRenderers(useExtensions()()) as Rendered[])
  return (
    <Contributed<Parameters<InlineCodeRenderer>[0]>
      core={() => <code {...props.attributes}>{props.code}</code>}
      props={{ code: props.code }}
      renderers={renderers()}
    />
  )
}

function CopyCode(props: { code: string; at: string }) {
  const { copied, copy } = useCopy()
  return (
    <Button
      aria-label={`Copy code ${props.at}`}
      class="h-auto rounded-none p-1 font-normal text-muted-foreground hover:text-foreground"
      onClick={() => copy(props.code)}
      size={null}
      title="Copy code"
      variant={null}
    >
      <Show when={copied()} fallback={<Copy class="size-3.5" />}>
        <Check class="size-3.5" />
      </Show>
    </Button>
  )
}

export function HighlightedCode(props: { code: string; language: string; lineNumbers?: boolean }) {
  const [loaded, setLoaded] = createSignal<{ code: string; lines: Line[] }>()
  const lines = createMemo(() => {
    const code = props.code.replace(/\n+$/, '')
    const known = loaded()
    if (known?.code === code) return known.lines
    return (
      highlight(code, props.language, (ready) => setLoaded({ code, lines: ready })) ??
      plainLines(code)
    )
  })
  const gutter = () => `${String(lines().length).length + 1}ch`
  return (
    <code>
      <For each={lines()} keyed={false}>
        {(line, index) => (
          <span class="block">
            <Show when={props.lineNumbers}>
              <span
                aria-hidden="true"
                class="mr-3 inline-block pr-1 text-right text-muted-foreground/50 select-none"
                style={{ width: gutter() }}
              >
                {index + 1}
              </span>
            </Show>
            <Show when={line().length} fallback={'\n'}>
              <For each={line()} keyed={false}>
                {(token) => <span style={token().htmlStyle}>{token().content}</span>}
              </For>
            </Show>
          </span>
        )}
      </For>
    </code>
  )
}

function CodeBlock(props: { code: string; language: string; incomplete: boolean; at: string }) {
  const renderers = createMemo(
    () => codeBlockRenderers(useExtensions()(), props.language) as Rendered[],
  )
  const core = () => (
    <div
      class="code-block"
      data-incomplete={props.incomplete || undefined}
      data-language={props.language}
    >
      <div class="code-block-header">
        <span>{props.language}</span>
        <CopyCode at={props.at} code={props.code} />
      </div>
      <pre class="shiki">
        <HighlightedCode code={props.code} language={props.language} />
      </pre>
    </div>
  )
  return (
    <Contributed<Parameters<CodeBlockRenderer>[0]>
      core={core}
      props={{ code: props.code, language: props.language, incomplete: props.incomplete }}
      renderers={renderers()}
    />
  )
}

const textOf = (node: ElementContent): string =>
  node.type === 'text' ? node.value : 'children' in node ? node.children.map(textOf).join('') : ''

function attributesOf(node: Element) {
  const attributes: Record<string, unknown> = {}
  for (const [property, value] of Object.entries(node.properties)) {
    if (value === undefined || value === null || value === false) continue
    if (property === 'align' && (node.tagName === 'td' || node.tagName === 'th')) {
      attributes.style = { 'text-align': String(value) }
      continue
    }
    const info = find(html, property)
    attributes[info.attribute] = Array.isArray(value)
      ? value.join(info.commaSeparated ? ', ' : ' ')
      : value
  }
  return attributes
}

type Context = { openFences: readonly number[]; without?: readonly string[]; place: string }

const fenceIncomplete = (node: Element, context: Context) =>
  context.openFences.includes(node.position?.start.offset ?? -1)

function Nodes(props: { nodes: ElementContent[]; context: Context }) {
  return (
    <For each={props.nodes} keyed={false}>
      {(node, index) => (
        <Node
          context={{
            get openFences() {
              return props.context.openFences
            },
            get without() {
              return props.context.without
            },
            get place() {
              return `${props.context.place}.${index}`
            },
          }}
          node={node()}
        />
      )}
    </For>
  )
}

function Node(props: { node: ElementContent; context: Context }): JSX.Element {
  return (
    <Switch>
      <Match when={props.node.type === 'text' && props.node}>{(text) => <>{text().value}</>}</Match>
      <Match
        when={
          props.node.type === 'element' &&
          !props.context.without?.includes(props.node.tagName) &&
          props.node
        }
      >
        {(element) => <ElementNode context={props.context} node={element()} />}
      </Match>
    </Switch>
  )
}

const hrefOf = (node: Element) => {
  const href = node.properties.href
  return typeof href === 'string' ? href : ''
}

const onlyImage = (node: Element) =>
  node.tagName === 'p' &&
  node.children.length === 1 &&
  node.children[0].type === 'element' &&
  node.children[0].tagName === 'img'

function fencedCode(node: Element) {
  const inner = node.tagName === 'pre' ? node.children[0] : undefined
  if (inner?.type !== 'element' || inner.tagName !== 'code') return undefined
  const classes = inner.properties.className
  const language = (Array.isArray(classes) ? classes : [])
    .map(String)
    .find((name) => name.startsWith('language-'))
  return { code: textOf(inner), language: language?.slice('language-'.length) ?? '' }
}

function ElementNode(props: { node: Element; context: Context }): JSX.Element {
  const attributes = createMemo(() => attributesOf(props.node))
  const Tag = dynamic(() => props.node.tagName)
  const children = () => <Nodes context={props.context} nodes={props.node.children} />
  return (
    <Switch fallback={<Tag {...attributes()}>{children()}</Tag>}>
      <Match when={fencedCode(props.node)}>
        {(block) => (
          <CodeBlock
            at={props.context.place}
            code={block().code}
            incomplete={fenceIncomplete(props.node, props.context)}
            language={block().language}
          />
        )}
      </Match>
      <Match when={props.node.tagName === 'a'}>
        <Anchor
          at={props.context.place}
          attributes={attributes()}
          href={hrefOf(props.node)}
          text={textOf(props.node)}
        >
          {children()}
        </Anchor>
      </Match>
      <Match when={props.node.tagName === 'code'}>
        <InlineCode attributes={attributes()} code={textOf(props.node)} />
      </Match>
      <Match when={props.node.tagName === 'table'}>
        <div class="table">
          <div>
            <table {...attributes()}>{children()}</table>
          </div>
        </div>
      </Match>
      <Match when={props.node.tagName === 'img'}>
        <span class="image">
          <img alt="" {...attributes()} />
        </span>
      </Match>
      <Match when={onlyImage(props.node)}>{children()}</Match>
    </Switch>
  )
}

function Block(props: {
  source: string
  streaming: boolean
  index: number
  markdown: number
  without?: readonly string[]
}) {
  const source = createMemo(() => (props.streaming ? closeUnfinished(props.source) : props.source))
  const tree = createProjection<{ nodes: ElementContent[]; openFences: number[] }>(
    (draft) => {
      const parsed = parse(source())
      draft.nodes = parsed.nodes
      draft.openFences = props.streaming ? parsed.openFences : []
    },
    { nodes: [], openFences: [] },
    { key: null },
  )
  return (
    <Nodes
      context={{
        get openFences() {
          return tree.openFences
        },
        get without() {
          return props.without
        },
        get place() {
          return `${props.markdown}.${props.index}`
        },
      }}
      nodes={tree.nodes}
    />
  )
}

let markdowns = 0

export function Markdown(props: {
  text: string
  streaming?: boolean
  without?: readonly string[]
  class?: string
}) {
  const markdown = ++markdowns
  const split = blockSplitterKeepingFinishedBlocks()
  const blocks = createMemo(() => split(props.text))
  return (
    <div class={cn('markdown min-w-0', props.class)}>
      <For each={blocks()} keyed={false}>
        {(source, index) => (
          <Block
            index={index}
            markdown={markdown}
            source={source()}
            streaming={!!props.streaming && index === blocks().length - 1}
            without={props.without}
          />
        )}
      </For>
    </div>
  )
}

type Mention = Exclude<ReturnType<typeof splitMentions>[number], string>

function Part(props: { part: string | Mention }) {
  const mention = () => (typeof props.part === 'string' ? undefined : props.part)
  return (
    <Show when={mention()} fallback={<>{props.part as string}</>}>
      {(link) => (
        <Anchor attributes={{}} href={mentionHref(link().conversation, link().entry)}>
          {link().text}
        </Anchor>
      )}
    </Show>
  )
}

export function MentionText(props: { text: string }) {
  return (
    <For each={splitMentions(props.text)} keyed={false}>
      {(part) => <Part part={part()} />}
    </For>
  )
}
