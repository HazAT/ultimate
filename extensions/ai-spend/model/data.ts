import type { Conversation, Row, Snapshot, SpendData } from './types.ts'

export type Item = { row: Row; conversation: Conversation }

const fallback = (id: number): Conversation => ({
  id,
  title: `#${id}`,
  agent: 'agent',
  family: null,
  root: id,
  busy: false,
  concluded: false,
  usage: 0,
  live: false,
})

export function merge(data: SpendData | null, delta: Snapshot): SpendData {
  const held = data && data.epoch === delta.epoch ? data : null
  const conversations = new Map(
    (held?.conversations ?? []).map((conversation) => [conversation.id, conversation]),
  )
  const rows = new Map<number, Row[]>()
  for (const row of held?.rows ?? []) {
    const list = rows.get(row.conversation)
    if (list) list.push(row)
    else rows.set(row.conversation, [row])
  }
  for (const conversation of delta.conversations) conversations.set(conversation.id, conversation)
  for (const [id, part] of Object.entries(delta.rows))
    rows.set(Number(id), [...(rows.get(Number(id)) ?? []).slice(0, part.from), ...part.rows])
  const ids = [...new Set([...conversations.keys(), ...rows.keys()])].toSorted((a, b) => a - b)
  return {
    epoch: delta.epoch,
    version: delta.version,
    since: delta.since,
    conversations: ids.flatMap((id) => conversations.get(id) ?? []),
    rows: ids.flatMap((id) => rows.get(id) ?? []),
    prices: delta.prices,
  }
}

export const itemsOf = (data: SpendData): Item[] => {
  const byId = new Map(data.conversations.map((conversation) => [conversation.id, conversation]))
  return data.rows.map((row) => ({
    row,
    conversation: byId.get(row.conversation) ?? fallback(row.conversation),
  }))
}
