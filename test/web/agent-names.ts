import { expect } from 'vitest'

const words = (text: string) =>
  ` ${text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[ßẞ]/g, 'ss')} `.replace(/[^\p{L}\p{N}]+/gu, ' ')

/**
 * Fails when one mounted control's name would also name another for the agent bridge, which resolves a name as whole
 * words of a label or row text, regardless of case and accents: "Save" also names "Quick save", "Run" not "Runner".
 */
export function expectDistinctAgentNames(agent: {
  snapshot(): { label?: string; row?: string; offPage?: boolean }[]
}) {
  const live = agent.snapshot().filter((entry) => !entry.offPage && entry.label)
  const clashes = live.flatMap((entry) =>
    live
      .filter(
        (other) =>
          other !== entry &&
          words(`${other.label} ${other.row ?? ''}`).includes(words(entry.label!)),
      )
      .map((other) => [entry.label, other.label]),
  )
  expect(clashes).toEqual([])
}
