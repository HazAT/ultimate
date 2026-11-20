/** @jsxImportSource @solidjs/web */
import { Check, Copy } from '@lucide/solid'
import { dynamic } from '@solidjs/web'
import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import { find, html } from 'property-information'
import { createMemo, createProjection, createSignal, Errored, For, Match, Show, Switch } from 'solid-js'
import type { Component } from 'solid-js'
import { ExtensionName, useCopy, useExtensions } from '@/sdk/solid'
import type { CodeBlockRenderer, InlineCodeRenderer, LinkRenderer } from '@/sdk'
import { codeBlockRenderers, inlineCodeRenderers, linkRenderers } from '../../sdk/registry.ts'
import { highlight, plainLines } from './highlight.ts'
import type { Line } from './highlight.ts'
import { incompleteLink, openFence, parse, repair, splitter } from './parse.ts'
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
      <Errored fallback={(error) => <ContributionError extension={extension} error={error()} inner={wrap(index - 1)} />}>
        <ExtensionName value={extension}>
          <Renderer {...(props.props as P)} core={wrap(index - 1)} />
        </ExtensionName>
      </Errored>
    )
  }
  return <>{wrap(props.renderers.length - 1)}</>
}

function ContributionError(props: { extension: string; error: unknown; inner: JSX.Element }) {
  console.error(`[extension ${props.extension}]`, props.error)
  const message = () => (props.error instanceof Error ? props.error.message : String(props.error))
  return (
    <>
      <span
        class="inline-flex max-w-72 items-center gap-1 rounded-sm bg-error/12 px-1.5 font-mono text-[11px] text-error"
        data-extension-error={props.extension}
        title={message()}
      >
        <span class="truncate">
          {props.extension}: {message()}
        </span>
      </span>
      {props.inner}
    </>
  )
}

function Anchor(props: { href: string; children: JSX.Element; attributes: Record<string, unknown> }) {
  const renderers = createMemo(() => linkRenderers(useExtensions()()) as Rendered[])
  const core = () =>
    parseMention(props.href) ? (
      props.children
    ) : (
      <a {...props.attributes} href={props.href} rel="noreferrer" target="_blank">
        {props.children}
      </a>
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

function CopyCode(props: { code: string }) {
  const { copied, copy } = useCopy()
  return (
    <button
      aria-label="Copy code"
      class="p-1 text-muted-foreground transition-colors hover:text-foreground"
      onClick={() => copy(props.code)}
      title="Copy code"
      type="button"
    >
      <Show when={copied()} fallback={<Copy class="size-3.5" />}>
        <Check class="size-3.5" />
      </Show>
    </button>
  )
}

export function HighlightedCode(props: { code: string; language: string }) {
  const [loaded, setLoaded] = createSignal<{ code: string; lines: Line[] }>()
  const lines = createMemo(() => {
    const code = props.code.replace(/\n+$/, '')
    const known = loaded()
    if (known?.code === code) return known.lines
    return highlight(code, props.language, (ready) => setLoaded({ code, lines: ready })) ?? plainLines(code)
  })
  return (
    <code>
      <For each={lines()} keyed={false}>
        {(line) => (
          <span class="block">
            <Show when={line().length} fallback={'\n'}>
              <For each={line()} keyed={false}>
                {(token) => <span style={token().htmlStyle as JSX.CSSProperties}>{token().content}</span>}
              </For>
            </Show>
          </span>
        )}
      </For>
    </code>
  )
}

function CodeBlock(props: { code: string; language: string; incomplete: boolean }) {
  const renderers = createMemo(() => codeBlockRenderers(useExtensions()(), props.language) as Rendered[])
  const core = () => (
    <div class="code-block" data-incomplete={props.incomplete || undefined} data-language={props.language}>
      <div class="code-block-header">
        <span>{props.language}</span>
        <CopyCode code={props.code} />
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
      attributes.style = `text-align:${String(value)}`
      continue
    }
    const info = find(html, property)
    attributes[info.attribute] = Array.isArray(value)
      ? value.join(info.commaSeparated ? ', ' : ' ')
      : value === true
        ? ''
        : value
  }
  return attributes
}

type Context = { incomplete: boolean; without?: readonly string[] }

function Nodes(props: { nodes: ElementContent[]; context: Context }) {
  return (
    <For each={props.nodes} keyed={false}>
      {(node) => <Node context={props.context} node={node()} />}
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
            code={block().code}
            incomplete={props.context.incomplete}
            language={block().language}
          />
        )}
      </Match>
      <Match when={props.node.tagName === 'a'}>
        <Anchor attributes={attributes()} href={String(props.node.properties.href ?? '')}>
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
          <img {...attributes()} />
        </span>
      </Match>
      <Match when={onlyImage(props.node)}>{children()}</Match>
    </Switch>
  )
}

function Block(props: { source: string; streaming: boolean; without?: readonly string[] }) {
  const tree = createProjection<{ nodes: ElementContent[] }>(
    (draft) => {
      draft.nodes = parse(props.streaming ? repair(props.source) : props.source)
    },
    { nodes: [] },
    { key: null },
  )
  return (
    <Nodes
      context={{
        get incomplete() {
          return props.streaming && openFence(props.source)
        },
        get without() {
          return props.without
        },
      }}
      nodes={tree.nodes}
    />
  )
}

/**
 * Markdown as the transcript shows it: GFM, `#id` mentions, highlighted code and sanitized raw HTML, with the
 * extensions' link, inline-code and code-block renderers. While `streaming`, only the last block re-renders as text
 * arrives, and what it leaves open is closed for the moment. `without` leaves out elements by tag name.
 */
export function Markdown(props: {
  text: string
  streaming?: boolean
  without?: readonly string[]
  class?: string
}) {
  const split = splitter()
  const blocks = createMemo(() => split(props.text))
  return (
    <div class={cn('markdown min-w-0', props.class)}>
      <For each={blocks()} keyed={false}>
        {(source, index) => (
          <Block
            source={source()}
            streaming={!!props.streaming && index === blocks().length - 1}
            without={props.without}
          />
        )}
      </For>
    </div>
  )
}

/** Text with `#id` and `#id/entry` mentions drawn as links, as Markdown draws them. */
export function MentionText(props: { text: string }) {
  return (
    <For each={splitMentions(props.text)} keyed={false}>
      {(part) => {
        const value = part()
        return typeof value === 'string' ? (
          value
        ) : (
          <Anchor attributes={{}} href={mentionHref(value.conversation, value.entry)}>
            {value.text}
          </Anchor>
        )
      }}
    </For>
  )
}
