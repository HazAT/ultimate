import { relative } from 'node:path'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { isInput } from '../../lib/entries.shared.ts'

const clip = (text: string, size: number) => text.replace(/\s+/g, ' ').trim().slice(0, size)
function textOf(entry: EntryRecord | undefined) {
  return (entry?.model ?? [])
    .flatMap((message) =>
      typeof message.content === 'string'
        ? [message.content]
        : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
    )
    .join(' ')
}

export function phaseState(
  chronologicalEntries: readonly EntryRecord[],
  projectAndWorktreeRoots: readonly string[],
) {
  const results = new Map(
    chronologicalEntries.flatMap((entry) =>
      (entry.model ?? []).flatMap((message) =>
        message.role === 'toolResult' ? [[message.toolCallId, message] as const] : [],
      ),
    ),
  )
  const calls = chronologicalEntries.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) =>
      message.role === 'assistant'
        ? message.content.filter((block) => block.type === 'toolCall')
        : [],
    ),
  )
  return {
    request: clip(textOf(chronologicalEntries.findLast(isInput)), 1500),
    recentTools: calls.slice(-15).map((call) => {
      const args = call.arguments
      let value: string
      switch (call.name) {
        case 'bash':
          value = clip(
            (typeof args.command === 'string' ? args.command : '').replace(
              /^\s*cd\s+(?:"[^"]*"|'[^']*'|\S+?)\s*(?:&&|;)\s*/,
              '',
            ),
            200,
          )
          break
        case 'read':
        case 'edit':
        case 'write': {
          const path = typeof args.path === 'string' ? args.path : ''
          const root = projectAndWorktreeRoots.find((candidate) => path.startsWith(candidate + '/'))
          value = root ? relative(root, path) : path
          break
        }
        case 'subagent':
          value = clip(
            [args.action, args.agent, args.id, args.background, args.task ?? args.text]
              .filter((part) => part !== undefined)
              .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
              .join(' '),
            160,
          )
          break
        case 'codemode':
          value = clip(typeof args.code === 'string' ? args.code : '', 160)
          break
        default:
          value = clip(JSON.stringify(args), 140)
      }
      const result = results.get(call.id)
      return {
        tool: call.name,
        args: value,
        ...(result?.isError
          ? {
              failed: clip(
                result.content
                  .flatMap((block) => (block.type === 'text' ? [block.text] : []))
                  .join(' '),
                140,
              ),
            }
          : {}),
      }
    }),
    agentSaid: clip(
      textOf(
        chronologicalEntries.findLast((entry) =>
          entry.model?.some(
            (message) =>
              message.role === 'assistant' &&
              message.content.some((block) => block.type === 'text' && block.text.length > 0),
          ),
        ),
      ),
      400,
    ),
  }
}
