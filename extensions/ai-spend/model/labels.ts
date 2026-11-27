import { SHOPIFY_PROXY, vendor } from './dimensions.ts'
import type { Dimension } from './dimensions.ts'
import { keyLabel } from './format.ts'
import type { Conversation, SpendData } from './types.ts'

export type Names = { byId: Map<number, Conversation>; served: Map<string, string> }

export function namesOf(data: SpendData): Names {
  const seen = new Map<string, string | null>()
  for (const row of data.rows) {
    if (row.overhead || vendor(row.provider, row.model) !== SHOPIFY_PROXY) continue
    const key = `${row.provider}/${row.model}`
    const served = row.served ?? null
    if (!seen.has(key)) seen.set(key, served)
    else if (seen.get(key) !== served) seen.set(key, null)
  }
  return {
    byId: new Map(data.conversations.map((conversation) => [conversation.id, conversation])),
    served: new Map([...seen].flatMap(([key, served]) => (served ? [[key, served]] : []))),
  }
}

export const labelOf = (dimension: Dimension, key: string, names: Names) =>
  dimension === 'conversation' || dimension === 'tree'
    ? (names.byId.get(Number(key))?.title ?? `#${key}`)
    : dimension === 'hour'
      ? `${key}:00`
      : dimension === 'model' && names.served.has(key)
        ? `${key} → ${names.served.get(key)}`
        : key

export function labeller(data: SpendData): (dimension: Dimension, key: string) => string {
  const names = namesOf(data)
  return (dimension, key) => keyLabel(dimension, key, labelOf(dimension, key, names))
}
