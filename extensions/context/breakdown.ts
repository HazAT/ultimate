// Pi upstream: @earendil-works/pi-durable@1.6.0 src/harness/prompt.ts — internal remove-all pi.system entry immediately precedes a reordered re-add, folded into the re-add's diff here. Drop when Pi exposes prompt reorder metadata instead of requiring entry-sequence inference.
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

export const startsContext = (entry: EntryRecord) =>
  entry.kind === 'pi.reset' || entry.kind === 'pi.compaction'

export function removesAll(entry: EntryRecord | undefined) {
  const values = Object.values(systemOf(entry)?.sections ?? {})
  return values.length > 0 && values.every((value) => value === null)
}

export const toolTokens = (tool: { name: string; description: string; parameters: unknown }) =>
  estimateTextTokens(
    JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }),
  )

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

function contextOrOwnStart(entries: readonly EntryRecord[], index: number, own: number) {
  let at = index
  while (at >= 0 && !startsContext(entries[at])) at--
  return Math.max(at, own)
}

function firstSystemFoldingReorder(entries: readonly EntryRecord[], from: number) {
  for (let at = from; at < entries.length; at++) {
    if (at > from && startsContext(entries[at])) return -1
    if (!systemOf(entries[at])) continue
    return removesAll(entries[at]) && systemOf(entries[at + 1]) ? at + 1 : at
  }
  return -1
}

export function opensContext(entries: readonly EntryRecord[], index: number, own: number) {
  const anchor = contextOrOwnStart(entries, index, own)
  return index >= anchor && firstSystemFoldingReorder(entries, anchor) === index
}

const injectedLabel = (entry: EntryRecord) => {
  if (entry.kind === 'pi.compaction') return 'compaction summary'
  const data = entry.data
  const lineage = data && typeof data === 'object' && 'lineage' in data ? data.lineage : undefined
  if (lineage && typeof lineage === 'object') {
    if ('brief' in lineage && lineage.brief) return 'memory brief'
    if ('tally' in lineage && lineage.tally) return 'tally'
  }
  return 'handoff'
}

const sum = (items: readonly { tokens: number }[] = []) =>
  items.reduce((total, item) => total + item.tokens, 0)

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

function inheritedWithLatestCompaction(
  entries: readonly EntryRecord[],
  own: number,
): Injected | undefined {
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
        : inheritedWithLatestCompaction(entries, anchor)
  const systemIndex = firstSystemFoldingReorder(entries, anchor)
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

export function diffAt(
  entries: readonly EntryRecord[],
  index: number,
  aside: ReadonlySet<number> = new Set(),
): Diff {
  const beforeReorderRemoval = removesAll(entries[index - 1]) ? index - 2 : index - 1
  const before = promptAt(entries, beforeReorderRemoval, aside)
  return comparePrompts(before, promptAt(entries, index, aside))
}

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

export const ownStart = (entries: readonly EntryRecord[], id: number | undefined) =>
  entries.findIndex((entry) => entry.conversationId === id)
