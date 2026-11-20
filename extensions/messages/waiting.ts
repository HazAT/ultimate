import type { EntryRecord } from '@earendil-works/pi-durable'
import { openQuestion } from '../../lib/message-state.ts'
import { callerOf } from './caller.ts'
import { AskedEntry } from './entries.ts'
import type { Message } from './refs.ts'

export type Question = {
  key: string
  card: string
} & ({ message: number; entry?: number } | { message?: undefined; entry: number })

export function questionsOf(
  id: number,
  messages: readonly Message[],
  entries: readonly EntryRecord[],
): Question[] {
  const open = messages.filter(openQuestion)
  if (!open.length) return []
  const ids = new Set(open.map((m) => m.id))
  const own = open
    .filter((m) => m.from === id)
    .map((m) => ({
      key: `m${m.id}`,
      message: m.id,
      card: `[data-message-outgoing="${m.id}"]`,
      entry: m.call ? callerOf(entries, m.call.split('/')[0])?.id : undefined,
    }))
  const pointed = entries
    .filter((candidate) => AskedEntry.is(candidate))
    .filter((e) => e.conversationId === id && ids.has(e.data.message ?? -1))
    .map((e) => ({
      key: `p${e.id}`,
      card: `[data-message-pointer="${e.data.message}"]`,
      entry: e.id,
    }))
  return [...own, ...pointed].toSorted((a, b) => (a.entry ?? -1) - (b.entry ?? -1))
}
