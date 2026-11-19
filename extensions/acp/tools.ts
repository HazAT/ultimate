import type { ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'
import type { JsonObject } from '@earendil-works/pi-durable'
import { createPatch } from 'diff'

const record = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const str = (value: unknown) => (typeof value === 'string' ? value : undefined)

type Diff = { path: string; oldText: string; newText: string }

export const fileLinksAsPaths = (text: string) =>
  text.replace(/\[([^\]]*)\]\(file:\/\/([^)\s]+)\)/g, (_link, label: string, path: string) => {
    const decoded = decodeURI(path)
    return !label || decoded.endsWith(label) ? `\`${decoded}\`` : `${label} (\`${decoded}\`)`
  })

function diffsOf(update: Record<string, unknown>): Diff[] {
  const content = Array.isArray(update.content) ? update.content : []
  return content.flatMap((item) => {
    const block = record(item)
    if (block.type !== 'diff' || typeof block.path !== 'string') return []
    return [
      { path: block.path, oldText: str(block.oldText) ?? '', newText: str(block.newText) ?? '' },
    ]
  })
}

function textOf(update: Record<string, unknown>): string {
  const content = Array.isArray(update.content) ? update.content : []
  return content
    .flatMap((item) => {
      const block = record(item)
      const inner = record(block.content)
      if (block.type === 'content' && inner.type === 'text' && typeof inner.text === 'string')
        return [inner.text]
      if (block.type === 'terminal') return [`[terminal ${String(block.terminalId)}]`]
      return []
    })
    .join('\n')
}

function pathOf(update: Record<string, unknown>, input: Record<string, unknown>) {
  const located = Array.isArray(update.locations) ? record(update.locations[0]).path : undefined
  return (
    str(located) ??
    str(input.path) ??
    str(input.file_path) ??
    str(input.filePath) ??
    str(input.AbsolutePath) ??
    str(input.TargetFile) ??
    ''
  )
}

function commandOf(input: Record<string, unknown>, title: string) {
  const command = input.command ?? input.CommandLine ?? input.cmd
  if (Array.isArray(command)) return command.filter((part) => typeof part === 'string').join(' ')
  return str(command) ?? title
}

export function toolCall(
  update: Record<string, unknown>,
  previous: ToolCall | undefined,
  agent: string,
): ToolCall {
  const id = String(update.toolCallId)
  const kind = str(update.kind) ?? str(previous?.arguments.kind)
  const title = str(update.title) ?? str(previous?.arguments.title) ?? ''
  const raw = record(update.rawInput)
  const input = Object.keys(raw).length ? raw : record(previous?.arguments.input)
  const diffs = diffsOf(update)
  const path = pathOf(update, input) || str(previous?.arguments.path) || ''
  const base = { type: 'toolCall' as const, id }
  if (kind === 'read')
    return { ...base, name: 'read', arguments: { path, title, kind, input: input as JsonObject } }
  if (kind === 'edit' || kind === 'delete' || kind === 'move') {
    const diff = diffs[0]
    if (diff && !diff.oldText)
      return {
        ...base,
        name: 'write',
        arguments: { path: diff.path, content: diff.newText, title, kind },
      }
    const edits = diff
      ? [{ oldText: diff.oldText, newText: diff.newText }]
      : ((previous?.arguments.edits as JsonObject[] | undefined) ?? [])
    return {
      ...base,
      name: 'edit',
      arguments: { path: diff?.path ?? path, edits, title, kind },
    }
  }
  if (kind === 'execute')
    return {
      ...base,
      name: 'bash',
      arguments: { command: commandOf(input, title), title, kind },
    }
  return {
    ...base,
    name: kind && kind !== 'other' ? `${agent} ${kind}` : title || 'tool',
    arguments: {
      title,
      ...(path ? { path } : {}),
      ...(kind ? { kind } : {}),
      input: input as JsonObject,
    },
  }
}

export function toolResult(
  call: ToolCall,
  update: Record<string, unknown>,
  failed: boolean,
): ToolResultMessage {
  const diffs = diffsOf(update)
  const patch = diffs
    .map((diff) => createPatch(diff.path, diff.oldText, diff.newText, '', '', { context: 3 }))
    .join('\n')
  const text =
    textOf(update) ||
    (diffs.length ? diffs.map((diff) => `Edited ${diff.path}`).join('\n') : failed ? 'Failed' : '')
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text }],
    ...(patch ? { details: { patch } } : {}),
    isError: failed,
    timestamp: Date.now(),
  }
}
