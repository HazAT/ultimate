// The Join card's `cloud.join`: a stub cloud on loopback answers `/sync/register`; secrets and settings land in a
// temporary user home.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join as path, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { writeSecret } from '../../secrets/store.ts'
import { cloudUrl, join, joinState, saveCloud } from '../join.ts'
import type { JoinDeps } from '../join.ts'
import { readStore } from '../../../lib/secrets.ts'
import { writeJson } from '../../../lib/json-file.ts'
import { context } from '../../../server/harness.ts'
import { fauxServer, post, temp } from '../../../test/helpers.ts'

const TOKEN = 'fleet-token-7f3e'
const KEY = 'snapshot-key-91ab'
let cloud: ReturnType<typeof createServer>
let base = ''
const seen: { path?: string; authorization?: string }[] = []
beforeAll(async () => {
  cloud = createServer((request, response) => {
    seen.push({
      ...(request.url ? { path: request.url } : {}),
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
    })
    if (request.url !== '/sync/register') response.writeHead(404).end()
    else if (request.headers.authorization !== `Bearer ${TOKEN}`)
      response.writeHead(401).end('unauthorized')
    else
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          projects: [{ hash: 'ab', key: 'github.com/hazat/ultimate', name: 'ultimate' }],
          machines: [],
        }),
      )
  })
  await new Promise<void>((done) => cloud.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${(cloud.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((done) => cloud.close(() => done())))

/** A user home and the deps `cloud.join` uses there: the real secret store and settings file. */
async function home() {
  const userHome = await temp('ultimate-join-')
  const deps: JoinDeps = {
    fetch: (input, init) => fetch(input, init),
    setSecret: (name, value) => writeSecret(userHome, name, value),
    saveCloud: saveCloud(userHome),
  }
  const settings = async () =>
    JSON.parse(await readFile(path(userHome, '.ultimate/settings.json'), 'utf8').catch(() => '{}'))
  const secrets = async () =>
    Object.fromEntries(
      Object.entries((await readStore(userHome)).secrets).map(([name, item]) => [name, item.value]),
    )
  return { userHome, deps, settings, secrets }
}

const input = (overrides: Record<string, unknown> = {}) => ({
  url: base,
  machine: 'rog',
  token: TOKEN,
  snapshotKey: KEY,
  ...overrides,
})

it('normalises cloud URLs to wss://<host>, keeps loopback ws:// for a local cloud, and refuses others', () => {
  expect(cloudUrl('https://ultimate.example.com/some/path?x=1')).toBe('wss://ultimate.example.com')
  expect(cloudUrl(' wss://ultimate.example.com/sync ')).toBe('wss://ultimate.example.com')
  expect(cloudUrl('http://127.0.0.1:8787')).toBe('ws://127.0.0.1:8787')
  for (const bad of [
    'http://ultimate.example.com',
    'ws://ultimate.example.com',
    'ftp://ultimate.example.com',
    'ultimate.example.com',
    'https://user:pass@ultimate.example.com',
    '',
  ])
    expect(cloudUrl(bad)).toBeUndefined()
})

it('stores both secrets and cloud.url/cloud.machine after the cloud answers 200, and lists its projects', async () => {
  const { userHome, deps, settings, secrets } = await home()
  await writeJson(path(userHome, '.ultimate/settings.json'), {
    theme: 'dark',
    cloud: { machine: 'old' },
  })
  expect((await joinState(userHome)).joined).toBeUndefined()
  const result = await join(deps, input())
  const url = base.replace('http:', 'ws:')
  expect(result).toEqual({
    ok: true,
    url,
    host: new URL(base).host,
    machine: 'rog',
    projects: ['ultimate'],
  })
  expect(seen.at(-1)).toEqual({ path: '/sync/register', authorization: `Bearer ${TOKEN}` })
  expect(await secrets()).toEqual({
    ULTIMATE_CLOUD_TOKEN: TOKEN,
    ULTIMATE_CLOUD_SNAPSHOT_KEY: KEY,
  })
  expect((await stat(path(userHome, '.ultimate/secrets.json'))).mode & 0o777).toBe(0o600)
  // Other settings stay.
  expect(await settings()).toEqual({
    theme: 'dark',
    cloud: { url, machine: 'rog' },
  })
  expect(await joinState(userHome)).toEqual({
    joined: { url, host: new URL(base).host, machine: 'rog' },
    url,
    machine: 'rog',
    missing: [],
  })
  // A re-run with the same values passes and leaves the same state.
  expect(await join(deps, input())).toEqual(result)
  expect(await secrets()).toEqual({
    ULTIMATE_CLOUD_TOKEN: TOKEN,
    ULTIMATE_CLOUD_SNAPSHOT_KEY: KEY,
  })
  expect(await settings()).toEqual({
    theme: 'dark',
    cloud: { url, machine: 'rog' },
  })
})

it('stores nothing when the cloud refuses the token or cannot be reached', async () => {
  const { userHome, deps, settings, secrets } = await home()
  expect(await join(deps, input({ token: 'wrong' }))).toEqual({
    ok: false,
    step: 'check',
    error: 'The cloud refused the token',
  })
  // A port nothing listens on.
  const closed = createServer()
  await new Promise<void>((done) => closed.listen(0, '127.0.0.1', done))
  const port = (closed.address() as AddressInfo).port
  await new Promise<void>((done) => closed.close(() => done()))
  expect(await join(deps, input({ url: `http://127.0.0.1:${port}` }))).toEqual({
    ok: false,
    step: 'check',
    error: `Cannot reach 127.0.0.1:${port}`,
  })
  // Servers that answer, but not as the cloud: HTML, or the old Worker's directory array.
  for (const body of ['<html>', '[{"name":"ultimate"}]']) {
    const notCloud = await join(
      { ...deps, fetch: async () => new Response(body, { status: 200 }) },
      input(),
    )
    expect(notCloud).toEqual({
      ok: false,
      step: 'check',
      error: `Cannot reach ${new URL(base).host}`,
    })
  }
  expect(await secrets()).toEqual({})
  expect(await settings()).toEqual({})
  expect((await joinState(userHome)).missing).toEqual([
    'ULTIMATE_CLOUD_TOKEN',
    'ULTIMATE_CLOUD_SNAPSHOT_KEY',
  ])
})

it('refuses a bad URL, machine name or missing secret before calling the cloud', async () => {
  const { deps, settings, secrets } = await home()
  const before = seen.length
  for (const [overrides, error] of [
    [
      { url: 'http://ultimate.example.com' },
      'The cloud URL must be wss://<host> or https://<host>',
    ],
    [{ url: 42 }, 'The cloud URL must be wss://<host> or https://<host>'],
    [{ machine: '-rog' }, 'The machine name takes letters'],
    [{ machine: 'my machine' }, 'The machine name takes letters'],
    [{ machine: 'a'.repeat(65) }, 'The machine name takes letters'],
    [{ token: ' ' }, 'ULTIMATE_CLOUD_TOKEN is required'],
    [{ snapshotKey: undefined }, 'ULTIMATE_CLOUD_SNAPSHOT_KEY is required'],
  ] as const) {
    const result = await join(deps, input(overrides))
    expect(result).toMatchObject({ ok: false, step: 'check' })
    expect(!result.ok && result.error).toContain(error)
  }
  expect(seen.length).toBe(before)
  expect(await secrets()).toEqual({})
  expect(await settings()).toEqual({})
})

it('names the step that failed when the secrets cannot be saved, and keeps settings untouched', async () => {
  const { deps, settings } = await home()
  const result = await join(
    {
      ...deps,
      setSecret: async () => {
        throw new Error('Secret store permissions are unsafe')
      },
    },
    input(),
  )
  expect(result).toEqual({
    ok: false,
    step: 'secrets',
    error: 'Secret store permissions are unsafe',
  })
  expect(await settings()).toEqual({})
})

it.concurrent('runs cloud.join for the UI and refuses it to agents', async () => {
  const userHome = await temp('ultimate-join-server-')
  await mkdir(path(userHome, 'project'))
  await writeJson(path(userHome, '.ultimate/settings.json'), { extensions: { enable: ['cloud'] } })
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: path(userHome, 'project'),
    userHome,
    home: path(userHome, 'state'),
    localSetup: false,
  })
  try {
    const ui = await post(server, '/api/extensions/cloud/actions/join', { args: input() })
    expect(ui.status).toBe(200)
    expect(ui.data.result).toMatchObject({ ok: true, machine: 'rog', projects: ['ultimate'] })
    expect((await readStore(userHome)).secrets.ULTIMATE_CLOUD_SNAPSHOT_KEY?.value).toBe(KEY)
    const state = await post(server, '/api/extensions/cloud/actions/joinState', {})
    expect(state.data.result.joined).toMatchObject({ machine: 'rog' })
    // The answer carries no secret values.
    expect(JSON.stringify([ui.data, state.data])).not.toMatch(new RegExp(`${TOKEN}|${KEY}`))

    const args = JSON.stringify(input({ machine: 'agent-machine' }))
    server.host.faux!.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('codemode', {
            code: `return await ultimate.action('cloud', 'join', ${args});`,
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Done'),
    ])
    await server.root.submit({ type: 'input', content: 'join the fleet' }, context)
    await server.harness.waitForIdle(context)
    const view = await server.root.context(context)
    const result = view.entries.findLast((entry) => entry.kind === 'pi.tool-result')!
    expect(JSON.stringify(result.model)).toContain('cloud/join is a user-only action')
    expect(
      JSON.parse(await readFile(path(userHome, '.ultimate/settings.json'), 'utf8')).cloud.machine,
    ).toBe('rog')
  } finally {
    await server.close()
  }
})
