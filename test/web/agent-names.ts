import { expect } from 'vitest'

export function expectDistinctAgentNames(agent: {
  snapshot(): { label?: string; offPage?: boolean }[]
}) {
  const labels = agent
    .snapshot()
    .flatMap(({ label, offPage }) => (!offPage && label ? [label] : []))
  const clashes = labels.flatMap((label, index) =>
    labels
      .slice(index + 1)
      .filter((other) => label.startsWith(other) || other.startsWith(label))
      .map((other) => [label, other]),
  )
  expect(clashes).toEqual([])
}
