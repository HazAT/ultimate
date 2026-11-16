import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { temp } from '../../../test/helpers.ts'
import type { UpdateState } from '../refs.ts'
import {
  actions,
  cameBack,
  RESTART_ALL_LOCK_MS,
  restartAllLocked,
  restartInSeries,
  restartNeeded,
} from '../server.ts'

const instance = (name: string, url: string) => ({ name, url })
const state = (restart: boolean, root = '/clone') =>
  ({ root, behind: 0, commits: [], install: false, restart }) as UpdateState

it('restarts only the instances that run this clone and say they owe a restart', () => {
  const a = instance('a', 'http://127.0.0.1:1')
  const b = instance('b', 'http://127.0.0.1:2')
  const c = instance('c', 'http://127.0.0.1:3')
  const d = instance('d', 'http://127.0.0.1:4')
  expect(
    restartNeeded('/clone', [
      { instance: a, state: state(true) },
      { instance: b, state: state(false) },
      { instance: c, state: state(true, '/other-clone') },
      { instance: d },
    ]),
  ).toEqual([a])
})

it('refuses a second attempt within a few minutes of the first', () => {
  expect(restartAllLocked(undefined, 1_000)).toBe(false)
  expect(restartAllLocked(1_000, 1_000 + 60_000)).toBe(true)
  expect(restartAllLocked(1_000, 1_000 + RESTART_ALL_LOCK_MS)).toBe(false)
})

it('counts an instance back only on the generation it announced or a later one', () => {
  expect(cameBack(2, undefined)).toBe(false)
  expect(cameBack(2, 1)).toBe(false)
  expect(cameBack(2, 2)).toBe(true)
  expect(cameBack(2, 3)).toBe(true)
})

it('restarts in series, and a refusal does not stop the rest', async () => {
  const a = instance('a', 'http://127.0.0.1:1')
  const b = instance('b', 'http://127.0.0.1:2')
  const c = instance('c', 'http://127.0.0.1:3')
  const asked: string[] = []
  const outcomes = await restartInSeries([a, b, c], {
    accept: async (target) => {
      asked.push(target.name)
      if (target.name === 'b') return { error: 'A core swap is already in progress.' }
      return { generation: 2 }
    },
    served: async () => 2,
    pause: async () => {},
    now: () => 0,
  })
  expect(asked).toEqual(['a', 'b', 'c'])
  expect(outcomes).toEqual([
    { ...a, ok: true, generation: 2 },
    { ...b, ok: false, error: 'A core swap is already in progress.' },
    { ...c, ok: true, generation: 2 },
  ])
})

it('reports an instance that never serves the generation it announced, and goes on', async () => {
  const a = instance('a', 'http://127.0.0.1:1')
  const b = instance('b', 'http://127.0.0.1:2')
  let now = 0
  const outcomes = await restartInSeries(
    [a, b],
    {
      accept: async () => ({ generation: 5 }),
      served: async (target) => (target.name === 'a' ? 4 : 5),
      pause: async () => {
        now += 1_000
      },
      now: () => now,
    },
    3_000,
  )
  expect(outcomes).toEqual([
    { ...a, ok: false, generation: 5, error: 'generation 5 did not serve within 3 s' },
    { ...b, ok: true, generation: 5 },
  ])
})

type Answers = {
  state?: UpdateState
  restart?: number | { error: string }
  generation?: number
}

async function fakeInstance(answers: Answers) {
  let restarts = 0
  const server: Server = createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (request.url === '/api/restart') {
      restarts += 1
      return typeof answers.restart === 'number'
        ? send(202, { ok: true, generation: answers.restart })
        : send(500, { ok: false, error: answers.restart?.error })
    }
    if (request.url?.endsWith('/update/actions/state')) return send(200, { result: answers.state })
    if (request.url?.endsWith('/status/actions/status'))
      return send(200, { result: { at: 0, generation: answers.generation } })
    send(404, { error: 'unknown' })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    restarts: () => restarts,
  }
}

it('asks each other instance on this clone in series and reports every outcome', async () => {
  const home = await temp('ultimate-update-restart-')
  const owed = await fakeInstance({ state: state(true), restart: 2, generation: 2 })
  const refusing = await fakeInstance({
    state: state(true),
    restart: { error: 'A core swap is already in progress.' },
  })
  const elsewhere = await fakeInstance({ state: state(true, '/other-clone'), restart: 2 })
  const current = await fakeInstance({ state: state(false) })
  const host = {
    home,
    ultimateRoot: '/clone',
    resource: (_key: string, create: () => unknown) => create(),
    projects: async () => [
      { name: 'here', current: true, running: { pid: 1, url: 'http://127.0.0.1:4747' } },
      { name: 'owed', current: false, running: { pid: 2, url: owed.url } },
      { name: 'refusing', current: false, running: { pid: 3, url: refusing.url } },
      { name: 'elsewhere', current: false, running: { pid: 4, url: elsewhere.url } },
      { name: 'current', current: false, running: { pid: 5, url: current.url } },
      { name: 'starting', current: false },
    ],
  } as unknown as ExtensionHost
  const context = { host, signal: new AbortController().signal } as never
  try {
    expect(await actions.restartAll(null, context)).toMatchObject({
      outcomes: [
        { name: 'owed', ok: true, generation: 2 },
        { name: 'refusing', ok: false, error: 'refusing: A core swap is already in progress.' },
      ],
    })
    expect([current.restarts(), elsewhere.restarts()]).toEqual([0, 0])
    expect(
      JSON.parse(await readFile(join(home, 'update-restart-all.json'), 'utf8')),
    ).toHaveProperty('at')
    expect(await actions.restartAll(null, context)).toMatchObject({
      outcomes: [],
      refused: expect.stringContaining('minutes'),
    })
  } finally {
    for (const fake of [owed, refusing, elsewhere, current]) fake.server.close()
  }
})
