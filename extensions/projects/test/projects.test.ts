import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { list } from '../server.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'

it('lists running projects with their own counts, another instance’s from its status, and one that fails without them', async () => {
  const other = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ result: { busy: 2, questions: { count: 1 } } }))
  })
  await new Promise<void>((done) => other.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(other.address() as AddressInfo).port}`
  const host = {
    projects: async () => [
      { name: 'down', current: false, running: { pid: 1, url: 'http://127.0.0.1:1' } },
      { name: 'stopped', current: false },
      { name: 'here', current: true, running: { pid: 2, url: 'http://127.0.0.1:4747' } },
      { name: 'other', current: false, running: { pid: 3, url } },
    ],
    conversations: () => [{ busy: true }, { busy: false }],
    need: () => ({ openQuestions: async () => [{}, {}, {}] }),
  } as unknown as ExtensionHost
  try {
    expect(await list(host, new AbortController().signal)).toEqual([
      { name: 'down', url: 'http://127.0.0.1:1', current: false },
      { name: 'here', url: 'http://127.0.0.1:4747', current: true, busy: 1, questions: 3 },
      { name: 'other', url, current: false, busy: 2, questions: 1 },
    ])
  } finally {
    other.close()
  }
})
