import type { createAgent } from '@ui-sdk/solid/agent'
import { expect } from 'vitest'

type Agent = ReturnType<typeof createAgent>

/**
 * Fails when a mounted control's name also names another for the agent bridge: asks the bridge's own `query`, which
 * matches labels and row text as the bridge resolves a step's name, for each label.
 */
export async function expectDistinctAgentNames(agent: Agent) {
  const live = agent.snapshot().filter((entry) => !entry.offPage && entry.label)
  const clashes: string[][] = []
  for (const { label, ref } of live) {
    const found = await agent.query({ text: label! })
    const others = Array.isArray(found) ? found.filter((other) => other.ref !== ref) : []
    if (others.length) clashes.push([label!, ...others.map((other) => other.label ?? other.ref)])
  }
  expect(clashes).toEqual([])
}
