import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { promptTokens } from '../../lib/context-usage.ts'

const isInput = (entry: EntryRecord) =>
  entry.model?.[0]?.role === 'user' && entry.kind !== 'pi.compaction'

export function turnOf(entries: readonly EntryRecord[], entry: EntryRecord) {
  const turn = { responses: 0, prompt: 0, output: 0, cost: 0, started: 0 }
  for (let index = entries.indexOf(entry); index >= 0; index--) {
    const message = entries[index].model?.[0]
    if (message?.role === 'assistant') {
      turn.responses++
      turn.prompt += promptTokens(message.usage)
      turn.output += message.usage.output
      turn.cost += message.usage.cost.total
    } else if (message && isInput(entries[index])) return { ...turn, started: message.timestamp }
  }
  return undefined
}

export function responseAfter(
  entries: readonly EntryRecord[],
  entry: EntryRecord,
): AssistantMessage | undefined {
  for (let index = entries.indexOf(entry) + 1; index > 0 && index < entries.length; index++) {
    const next = entries[index]
    if (next.kind === 'pi.compaction' || next.kind === 'pi.reset') return undefined
    const message = next.model?.[0]
    if (message?.role === 'assistant') return message
  }
  return undefined
}
