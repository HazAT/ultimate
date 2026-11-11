// Pi upstream: @earendil-works/pi-durable@1.5.2 src/harness/prompt.ts — internal remove-all pi.system entry immediately precedes a reordered re-add, folded into the re-add's diff here. Drop when Pi exposes prompt reorder metadata instead of requiring entry-sequence inference.
import type { Message, SystemMessage } from '@earendil-works/pi-ai'
import {
  estimateMessageTokens,
  estimateTextAndImageContentTokens,
  estimateTextTokens,
} from '@earendil-works/pi-ai/utils/estimate'
import type { EntryRecord } from '@earendil-works/pi-durable'
import type { Breakdown, Diff, Injected, Prompt, SectionChange, ToolChange } from './types.ts'

export type * from './types.ts'

export const systemOf = (entry: EntryRecord | undefined): SystemMessage | undefined => {
  const message = entry?.model?.[0]
  return entry?.kind === 'pi.system' && message?.role === 'system' ? message : undefined
}

/** A reset or compaction: the model's context starts again here. */
export const startsContext = (entry: EntryRecord) =>
  entry.kind === 'pi.reset' || entry.kind === 'pi.compaction'

/** A patch removing every section, which Pi Durable writes right before re-adding them in a new order. */
export function removesAll(entry: EntryRecord | undefined) {
  const values = Object.values(systemOf(entry)?.sections ?? {})
  return values.length > 0 && values.every((value) => value === null)
}

export const toolTokens = (tool: { name: string; description: string; parameters: unknown }) =>
  estimateTextTokens(
    JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }),
  )

/**
 * The prompt replayed from the context start before `index` through `index`: `null` removes, re-adding appends. Entries
 * in `aside`, which a go-back set aside (`setAsideIds`), left the model's context and do not count.
 */
export function promptAt(
  entries: readonly EntryRecord[],
  index: number,
  aside: ReadonlySet<number> = new Set(),
): Prompt {
  let from = index
  while (from >= 0 && !startsContext(entries[from])) from--
  const messages: SystemMessage[] = []
  for (let at = from + 1; at <= index; at++) {
    const message = aside.has(entries[at].id) ? undefined : systemOf(entries[at])
    if (message) messages.push(message)
  }
  return promptOf(messages)
}

/** The prompt the system messages among `messages` add up to, such as a model context's: `null` removes, re-adding appends. */
export function promptOf(messages: readonly Message[]): Prompt {
  const sections = new Map<string, string>()
  const tools = new Map<string, NonNullable<SystemMessage['toolsAdded']>[number]>()
  for (const message of messages) {
    if (message.role !== 'system') continue
    for (const [key, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(key)
      else sections.set(key, value)
    }
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name)
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool)
  }
  return {
    sections: [...sections].map(([key, text]) => ({ key, text, tokens: estimateTextTokens(text) })),
    tools: [...tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      tokens: toolTokens(tool),
    })),
  }
}

/** Where the context of `index` starts: its reset or compaction, or `own`, the conversation's first entry, if later. */
function anchorOf(entries: readonly EntryRecord[], index: number, own: number) {
  let at = index
  while (at >= 0 && !startsContext(entries[at])) at--
  return Math.max(at, own)
}

/** The first `pi.system` at or after `from`, before the next context start; a remove-all and its re-add count as one. */
function firstSystem(entries: readonly EntryRecord[], from: number) {
  for (let at = from; at < entries.length; at++) {
    if (at > from && startsContext(entries[at])) return -1
    if (!systemOf(entries[at])) continue
    return removesAll(entries[at]) && systemOf(entries[at + 1]) ? at + 1 : at
  }
  return -1
}

/**
 * Whether the `pi.system` at `index` opens its context, alone or as the re-add after a remove-all: the breakdown above
 * the context shows it instead.
 */
export function opensContext(entries: readonly EntryRecord[], index: number, own: number) {
  const anchor = anchorOf(entries, index, own)
  return index >= anchor && firstSystem(entries, anchor) === index
}

const injectedLabel = (entry: EntryRecord) => {
  if (entry.kind === 'pi.compaction') return 'compaction summary'
  const lineage = (entry.data as { lineage?: { brief?: unknown; tally?: unknown } } | undefined)
    ?.lineage
  if (lineage?.brief) return 'memory brief'
  if (lineage?.tally) return 'tally'
  return 'handoff'
}

const sum = (items: readonly { tokens: number }[] = []) =>
  items.reduce((total, item) => total + item.tokens, 0)

/** The text of a message as one block, for history a fork inherited into its context. */
function plain(entry: EntryRecord) {
  const message = entry.model?.[0]
  if (!message || message.role === 'system') return ''
  const blocks = typeof message.content === 'string' ? [message.content] : message.content
  const text = blocks
    .flatMap((block) =>
      typeof block === 'string'
        ? [block]
        : block.type === 'text'
          ? [block.text]
          : block.type === 'toolCall'
            ? [`${block.name}(${JSON.stringify(block.arguments)})`]
            : block.type === 'image'
              ? ['[image]']
              : [],
    )
    .join('\n')
  return text && `${message.role}: ${text}`
}

/**
 * The history a fork carries into its first context: its source's entries from their last context start up to `own`,
 * the fork's first entry. A compaction keeps the entries from its `head` on, before its marker too, but no older
 * compaction's summary: Pi shows only the newest. Empty when the fork starts its own context.
 */
function inherited(entries: readonly EntryRecord[], own: number): Injected | undefined {
  if (own <= 0 || startsContext(entries[own])) return undefined
  let from = own - 1
  while (from > 0 && !startsContext(entries[from])) from--
  const start = entries[from]
  const head = start?.kind === 'pi.compaction' ? start.head : undefined
  const kept =
    head === undefined
      ? entries.slice(from, own)
      : [
          start,
          ...entries
            .slice(0, own)
            .filter((entry) => entry.id >= head && entry.kind !== 'pi.compaction'),
        ]
  const carried = kept.filter((entry) => {
    const role = entry.model?.[0]?.role
    return role !== undefined && role !== 'system'
  })
  if (carried.length === 0) return undefined
  return {
    label: `inherited history · ${carried.length} messages`,
    content: carried.map(plain).filter(Boolean).join('\n\n'),
    tokens: carried.reduce((total, entry) => total + estimateMessageTokens(entry.model![0]), 0),
  }
}

/**
 * The breakdown of the context that starts at `anchor`, a reset or compaction, or the conversation's first entry:
 * what it injected, the first system prompt after it, and the model of its first response. A fork's own first entry
 * that starts no context of its own carries its source's history in, which counts as injected.
 */
export function breakdownAt(entries: readonly EntryRecord[], anchor: number): Breakdown {
  const start = entries[anchor] && startsContext(entries[anchor]) ? entries[anchor] : undefined
  const message = start?.model?.[0]
  const injected =
    start && message?.role === 'user'
      ? {
          label: injectedLabel(start),
          entry: start,
          content: message.content,
          tokens: estimateTextAndImageContentTokens(message.content),
        }
      : start
        ? undefined
        : inherited(entries, anchor)
  const systemIndex = firstSystem(entries, anchor)
  const prompt = systemIndex < 0 ? undefined : promptAt(entries, systemIndex)
  let model: Breakdown['model']
  for (let at = Math.max(systemIndex, anchor) + 1; at < entries.length && !model; at++) {
    if (startsContext(entries[at])) break
    const response = entries[at].model?.[0]
    if (entries[at].kind === 'pi.assistant' && response?.role === 'assistant')
      model = {
        provider: response.provider,
        model: response.model,
        ...(response.thinkingLevel ? { thinking: response.thinkingLevel } : {}),
      }
  }
  const tokens = {
    prompt: sum(prompt?.sections),
    tools: sum(prompt?.tools),
    injected: injected?.tokens ?? 0,
    total: 0,
  }
  tokens.total = tokens.prompt + tokens.tools + tokens.injected
  return {
    ...(start ? { start } : {}),
    ...(injected ? { injected } : {}),
    ...(systemIndex >= 0 ? { system: entries[systemIndex], prompt } : {}),
    ...(model ? { model } : {}),
    tokens,
  }
}

/**
 * How the `pi.system` at `index` changed the prompt. A remove-all patch right before it belongs to it: the diff is
 * taken against the state before that one, so a reorder shows only what really changed.
 */
export function diffAt(
  entries: readonly EntryRecord[],
  index: number,
  aside: ReadonlySet<number> = new Set(),
): Diff {
  const before = promptAt(entries, removesAll(entries[index - 1]) ? index - 2 : index - 1, aside)
  return comparePrompts(before, promptAt(entries, index, aside))
}

/** How `after` differs from `before`: each section and tool added, changed or removed, with its token delta. */
export function comparePrompts(before: Prompt, after: Prompt): Diff {
  const sections: SectionChange[] = []
  const old = new Map(before.sections.map((section) => [section.key, section]))
  for (const section of after.sections) {
    const previous = old.get(section.key)
    old.delete(section.key)
    if (previous?.text === section.text) continue
    sections.push({
      key: section.key,
      change: previous ? 'changed' : 'added',
      text: section.text,
      ...(previous && { before: previous.text }),
      delta: section.tokens - (previous?.tokens ?? 0),
    })
  }
  for (const section of old.values())
    sections.push({
      key: section.key,
      change: 'removed',
      text: section.text,
      delta: -section.tokens,
    })
  const tools: ToolChange[] = []
  const offered = new Map(before.tools.map((tool) => [tool.name, tool]))
  for (const tool of after.tools) {
    const previous = offered.get(tool.name)
    offered.delete(tool.name)
    if (previous && JSON.stringify(previous) === JSON.stringify(tool)) continue
    tools.push({
      name: tool.name,
      change: previous ? 'changed' : 'added',
      tool,
      delta: tool.tokens - (previous?.tokens ?? 0),
    })
  }
  for (const tool of offered.values())
    tools.push({ name: tool.name, change: 'removed', tool, delta: -tool.tokens })
  const delta = [...sections, ...tools].reduce((total, change) => total + change.delta, 0)
  return { sections, tools, delta }
}

/**
 * The model line of a breakdown: the model and thinking level its first response recorded, or, before any response,
 * the conversation's configured ones, marked `configured` since no request has used them yet.
 */
export function modelLine(
  recorded: Breakdown['model'],
  configured: { model?: { provider: string; modelId: string }; thinkingLevel?: string },
): { text: string; configured: boolean } | undefined {
  if (recorded)
    return {
      text: `${recorded.provider}/${recorded.model}${recorded.thinking ? ` · ${recorded.thinking}` : ''}`,
      configured: false,
    }
  if (!configured.model) return undefined
  const { provider, modelId } = configured.model
  return {
    text: `${provider}/${modelId}${configured.thinkingLevel ? ` · ${configured.thinkingLevel}` : ''}`,
    configured: true,
  }
}

/** The index of the shown conversation's first own entry; a fork's earlier entries are its source's history. */
export const ownStart = (entries: readonly EntryRecord[], id: number | undefined) =>
  entries.findIndex((entry) => entry.conversationId === id)
