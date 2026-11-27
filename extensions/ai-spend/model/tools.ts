import { NO_TOOL, OVERHEAD, prompt } from './dimensions.ts'
import type { Filter } from './dimensions.ts'
import { itemsIn, scaleOf, selected } from './filter.ts'
import type { SpendData } from './types.ts'

export type ToolCost = {
  tool: string
  usd: number
  directUsd: number
  inputShare: number
  avgRereads: number
}

export function tools(data: SpendData, filter: Filter): ToolCost[] {
  const byTool = new Map<string, ToolCost & { tokens: number; carried: number; added: number }>()
  let prompts = 0
  for (const item of itemsIn(data, filter)) {
    const { row } = item
    const grow = scaleOf(item, filter, 'tool')
    if (!row.overhead) prompts += prompt(row) * grow
    for (const part of selected(item, filter, 'tool')) {
      if (part.key === NO_TOOL || part.key === OVERHEAD) continue
      let tool = byTool.get(part.key)
      if (!tool)
        byTool.set(
          part.key,
          (tool = {
            tool: part.key,
            usd: 0,
            directUsd: 0,
            inputShare: 0,
            avgRereads: 0,
            tokens: 0,
            carried: 0,
            added: 0,
          }),
        )
      tool.usd += part.usd
      if (row.overhead) tool.directUsd += part.usd
      else {
        tool.tokens += part.tokens
        tool.carried += row.tools?.[part.key]?.carried ?? 0
        tool.added += row.tools?.[part.key]?.added ?? 0
      }
    }
  }
  return [...byTool.values()]
    .map(({ tokens, carried, added, ...tool }) => ({
      ...tool,
      inputShare: prompts > 0 ? tokens / prompts : 0,
      avgRereads: added > 0 ? carried / added : 0,
    }))
    .toSorted((a, b) => b.usd - a.usd)
}
