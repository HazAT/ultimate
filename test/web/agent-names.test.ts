import { expect, it } from 'vitest'
import { expectDistinctAgentNames } from './agent-names.ts'

const page = (...labels: string[]) => ({ snapshot: () => labels.map((label) => ({ label })) })

it('flags a name the bridge would also resolve to another control, as whole words regardless of case', () => {
  expect(() => expectDistinctAgentNames(page('Save', 'Quick save'))).toThrow('Quick save')
  expect(() => expectDistinctAgentNames(page('Sounds', 'Sounds'))).toThrow('Sounds')
  expect(() =>
    expectDistinctAgentNames(page('Run', 'Runner', 'Sound settings', 'Sounds')),
  ).not.toThrow()
})
