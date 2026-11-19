import { expect, it, vi } from 'vitest'

it('makes every write on a page an agent opened the agent’s, the app’s own writes excepted', async () => {
  vi.resetModules()
  const { agentsPage, writerNow, writingAs } = await import('../web/src/sdk/writer.ts')
  expect(writerNow()).toBe('person')
  expect(writingAs('mouse', writerNow)).toBe('person')
  agentsPage()
  expect(writerNow()).toBe('agent')
  expect(writingAs('keyboard', writerNow)).toBe('agent')
  expect(writingAs('app', writerNow)).toBe('app')
  expect(writerNow()).toBe('agent')
})
