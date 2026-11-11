import { expect, it } from 'vitest'
import { status } from '../server.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'

const services: Record<string, unknown> = {
  update: {
    state: async () => ({
      root: '/clone',
      head: 'abc123',
      branch: 'main',
      behind: 3,
      ahead: 1,
      commits: [{ sha: 'def', subject: 'New' }],
      fetchedAt: 900,
      install: false,
      restart: false,
    }),
  },
  watchdog: {
    failures: async (since: number) =>
      [
        { conversation: 7, title: 'Fix', at: 950, error: 'boom', step: 'bash', retried: true },
      ].filter((failure) => failure.at >= since),
  },
  health: {
    providers: async () => [
      { provider: 'a', state: 'ok', lastOk: 1, error: 'old' },
      { provider: 'b', state: 'failing', lastFail: 2, error: 'invalid_grant' },
    ],
  },
  messages: {
    openQuestions: async () => [
      { message: 4, conversation: 9, at: 10, text: 'Ship it?' },
      { message: 5, conversation: 8, at: 20, text: 'Which one?' },
    ],
  },
}
const host = (off: string[] = []) =>
  ({
    want: (api: { name: string }) => (off.includes(api.name) ? undefined : services[api.name]),
    need: (api: { name: string }) => services[api.name],
    conversations: () => [{ busy: true }, { busy: false }, { busy: true }],
    extensions: () => [
      { name: 'status', source: 'builtin', enabled: true, path: '/x', server: { docs: [] } },
      { name: 'cloud', source: 'builtin', enabled: false, path: '/y' },
      { name: 'deploys', source: 'user', enabled: true, server: { error: 'SyntaxError' } },
    ],
  }) as unknown as ExtensionHost
const extensions = [
  { name: 'status', source: 'builtin', enabled: true },
  { name: 'cloud', source: 'builtin', enabled: false },
  { name: 'deploys', source: 'user', enabled: true, error: 'SyntaxError' },
]

it('summarizes the clone, failures, providers, questions and busy conversations from their owners', async () => {
  expect(await status(host(), 940, 1000)).toEqual({
    at: 1000,
    head: { sha: 'abc123', branch: 'main', behind: 3, ahead: 1, fetchedAt: 900 },
    failures: [{ conversation: 7, title: 'Fix', at: 950, error: 'boom', retried: true }],
    providers: [
      { provider: 'a', state: 'ok' },
      { provider: 'b', state: 'failing', error: 'invalid_grant' },
    ],
    questions: { count: 2, first: { text: 'Ship it?', conversation: 9, message: 4 } },
    busy: 2,
    extensions,
  })
  expect((await status(host(), 960, 1000)).failures).toEqual([])
})

it('leaves out what an extension that is off owns', async () => {
  expect(await status(host(['update', 'watchdog', 'health']), 0, 1000)).toEqual({
    at: 1000,
    questions: { count: 2, first: { text: 'Ship it?', conversation: 9, message: 4 } },
    busy: 2,
    extensions,
  })
})

it('still answers when Update fails, as while origin has no default branch', async () => {
  const failing = host()
  const update = {
    state: async () => {
      throw new Error('origin has no default branch; run git remote set-head origin --auto')
    },
  }
  failing.want = ((api: { name: string }) =>
    api.name === 'update' ? update : services[api.name]) as ExtensionHost['want']
  const result = await status(failing, 940, 1000)
  expect(result.head).toBeUndefined()
  expect(result.questions.count).toBe(2)
})
