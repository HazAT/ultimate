import type { createAgent } from '@ui-sdk/solid/agent'
import { expect } from 'vitest'

type Agent = ReturnType<typeof createAgent>

/**
 * Fails when a mounted control's label does not resolve to that control alone: looks each label up with the bridge's
 * own resolver (`query({ within })`, which `act` uses for a step's name) without acting.
 */
export async function expectDistinctAgentNames(agent: Agent) {
  const live = agent.snapshot().filter((entry) => !entry.offPage && entry.label)
  const clashes: string[] = []
  for (const { label, ref } of live) {
    const found = await agent.query({ within: label! })
    if (!Array.isArray(found)) clashes.push(found.error)
    else if (found[0]?.ref !== ref)
      clashes.push(`"${label}" resolves to ${found[0]?.ref}, not ${ref}`)
  }
  expect(clashes).toEqual([])
}
