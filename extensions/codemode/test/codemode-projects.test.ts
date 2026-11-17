import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import type { Register } from '../../../lib/cloud.ts'
import { actions } from '../server.ts'
import { readProject } from '../projects.ts'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { writeJson } from '../../../lib/json-file.ts'
import { locate, resolveProject } from '../../../lib/remote.ts'
import { temp } from '../../../test/helpers.ts'
import type { ActionContext } from '../../../server/actions.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'

const here = { name: 'ultimate', root: '/p/ultimate', current: true }
const hash = 'ab'.repeat(32)
/** A register naming poe2-rust's latest backup from haza-pc, with the tailnets each side recorded. */
const register = (tailnet?: { latest?: string; machine?: string }): Register => ({
  projects: [
    {
      hash,
      key: 'github.com/hazat/poe2-rust',
      name: 'poe2-rust',
      latest: {
        id: 'b1',
        machine: 'haza-pc',
        at: 0,
        bytes: 1,
        uploaded: 1,
        parent: null,
        ...(tailnet?.latest ? { tailnet: tailnet.latest } : {}),
      },
    },
  ],
  machines: [
    {
      machine: 'haza-pc',
      at: 0,
      projects: {
        [hash]: {
          name: 'poe2-rust',
          at: 0,
          ...(tailnet?.machine ? { tailnet: tailnet.machine } : {}),
        },
      },
    },
  ],
})

it("resolves this project, a running local one, and the last backup's tailnet address", () => {
  expect(resolveProject('ultimate', [here], undefined)).toEqual({ current: true })
  const local = { name: 'poe2-rust', current: false, running: { url: 'http://127.0.0.1:4748' } }
  // A local running project wins over the register.
  expect(
    resolveProject('poe2-rust', [here, local], register({ latest: 'https://elsewhere' })),
  ).toEqual({ url: 'http://127.0.0.1:4748', label: 'poe2-rust on this machine', name: 'poe2-rust' })
  const tailnet = 'https://haza-pc.tail.ts.net:4748'
  // Names and keys match case-insensitively.
  for (const name of ['poe2-rust', 'github.com/HazAT/poe2-rust'])
    expect(resolveProject(name, [here], register({ latest: tailnet }))).toEqual({
      url: tailnet,
      label: 'poe2-rust on haza-pc',
      name: 'poe2-rust',
      machine: 'haza-pc',
    })
  // Without one on the backup, the machine's own record of the project names it.
  expect(resolveProject('poe2-rust', [here], register({ machine: tailnet }))).toEqual({
    url: tailnet,
    label: 'poe2-rust on haza-pc',
    name: 'poe2-rust',
    machine: 'haza-pc',
  })
  // A named machine picks that machine's instance, even past a local one.
  const local2 = { name: 'poe2-rust', current: false, running: { url: 'http://127.0.0.1:4748' } }
  expect(
    resolveProject('poe2-rust', [here, local2], register({ machine: tailnet }), {
      name: 'haza-pc',
      here: false,
    }),
  ).toMatchObject({ url: tailnet, machine: 'haza-pc' })
  expect(() =>
    resolveProject('poe2-rust', [here], register(), { name: 'rog', here: false }),
  ).toThrow('poe2-rust on rog registered no tailnet address')
})

it('stops a remote read when its call is cancelled', async () => {
  let asked!: () => void
  const reached = new Promise<void>((resolve) => (asked = resolve))
  // Never answers: only the caller's signal can end the request.
  const server = createServer(() => asked())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const host = {
      projects: async () => [
        { name: 'ultimate', current: true },
        { name: 'poe2-rust', current: false, running: { url } },
      ],
    } as unknown as ExtensionHost
    const controller = new AbortController()
    const read = readProject(host, { project: 'poe2-rust' }, 'trace', [], controller.signal)
    await reached
    controller.abort()
    await expect(read).rejects.toThrow('poe2-rust on this machine did not answer')
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

it('reads a project on another machine through the register, with the cloud token', async () => {
  const seen: string[] = []
  const listen = (body: (path: string, auth?: string) => [number, unknown]) => {
    const server = createServer((request, response) => {
      seen.push(`${request.url} ${request.headers.origin ?? ''}`)
      const [status, json] = body(request.url ?? '', request.headers.authorization)
      response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(json))
    })
    return new Promise<{ url: string; close: () => void }>((resolve) =>
      server.listen(0, '127.0.0.1', () =>
        resolve({
          url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          close: () => server.close(),
        }),
      ),
    )
  }
  const remote = await listen(() => [200, { result: ['from haza-pc'] }])
  const cloud = await listen((path, auth) =>
    path === '/sync/register' && auth === 'Bearer token'
      ? [200, register({ latest: remote.url })]
      : [401, { error: 'unauthorized' }],
  )
  try {
    const host = {
      userHome: '/nonexistent',
      notice: () => {},
      projects: async () => [{ name: 'ultimate', current: true }],
    } as unknown as ExtensionHost
    // Without remotes or cloud backups other machines are unknown.
    await expect(readProject(host, { project: 'poe2-rust' }, 'trace', [])).rejects.toThrow(
      'reached only through remotes in user settings or cloud backups',
    )
    process.env.ULTIMATE_CLOUD_URL = cloud.url.replace('http', 'ws')
    process.env.ULTIMATE_CLOUD_TOKEN = 'token'
    expect(await readProject(host, { project: 'poe2-rust' }, 'trace', [])).toEqual({
      value: ['from haza-pc'],
    })
    // The remote instance is asked with its own origin.
    expect(seen).toContain(`/api/extensions/codemode/actions/read ${remote.url}`)
    process.env.ULTIMATE_CLOUD_TOKEN = 'wrong'
    await expect(readProject(host, { project: 'poe2-rust' }, 'trace', [])).rejects.toThrow(
      'GET /sync/register returned 401',
    )
  } finally {
    delete process.env.ULTIMATE_CLOUD_URL
    delete process.env.ULTIMATE_CLOUD_TOKEN
    for (const server of [remote, cloud]) server.close()
  }
})

it('caps an answer at 1 MiB of encoded JSON, counting multibyte characters as bytes', async () => {
  // 400k three-byte characters: under 1 Mi characters, over 1 MiB.
  const big = [{ name: '€'.repeat(400_000) }]
  const host = {
    trace: { query: () => big, tree: () => [] },
  } as unknown as ExtensionHost
  const ctx = { host, signal: new AbortController().signal } as ActionContext
  await expect(actions.read({ op: 'trace', args: [] }, ctx)).rejects.toThrow('larger than 1 MiB')
})

it("answers another project's read of an exported document, and refuses an unknown kind", async () => {
  const todos = { definition: { kind: 'todos', initial: () => ({ next: 1, items: [] }) } }
  const host = {
    doc: (kind: string) => (kind === 'todos' ? todos : undefined),
    harness: () => ({
      snapshot: async (_doc: unknown, id: number) => (id === 1 ? { next: 2, items: [1] } : null),
    }),
  } as unknown as ExtensionHost
  const ctx = { host, signal: new AbortController().signal } as ActionContext
  expect(await actions.read({ op: 'doc', args: ['todos', 1] }, ctx)).toEqual({
    next: 2,
    items: [1],
  })
  expect(await actions.read({ op: 'doc', args: ['todos', 4] }, ctx)).toEqual({ next: 1, items: [] })
  await expect(actions.read({ op: 'doc', args: ['nope', 1] }, ctx)).rejects.toThrow(
    'Unknown conversation document: nope',
  )
})

it('reaches another machine at the address the user set in remotes, with no cloud', async () => {
  const userHome = await temp()
  await writeJson(join(userHome, '.ultimate/settings.json'), {
    remotes: {
      laptop: {
        Ultimate: 'https://laptop.tail.ts.net:4747',
        blog: 'https://laptop.tail.ts.net:4748',
      },
      desktop: { blog: 'https://desktop.tail.ts.net:4747' },
    },
  })
  const host = {
    userHome,
    notice: () => {},
    projects: async () => [{ name: 'ultimate', current: true }],
  } as unknown as ExtensionHost
  // The project runs here too, so it answers here, unless the other machine is named.
  expect(await locate(host, 'ultimate')).toEqual({ current: true })
  expect(await locate(host, 'ultimate', 'laptop')).toEqual({
    url: 'https://laptop.tail.ts.net:4747',
    label: 'Ultimate on laptop',
    name: 'Ultimate',
    machine: 'laptop',
  })
  expect(await locate(host, 'ultimate', hostname())).toEqual({ current: true })
  // A project listed on several machines needs one named.
  await expect(locate(host, 'blog')).rejects.toThrow('blog runs on laptop, desktop in remotes')
  expect(await locate(host, 'blog', 'desktop')).toMatchObject({ machine: 'desktop' })
  await expect(locate(host, 'shop', 'laptop')).rejects.toThrow('Unknown project shop on laptop')
})

it('reads a project listed on several machines from the one the read names', async () => {
  const server = createServer((_request, response) =>
    response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ result: ['from desktop'] })),
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const userHome = await temp()
    await writeJson(join(userHome, '.ultimate/settings.json'), {
      remotes: {
        laptop: { blog: 'http://127.0.0.1:1' },
        desktop: { blog: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
      },
    })
    const host = {
      userHome,
      notice: () => {},
      projects: async () => [{ name: 'ultimate', current: true }],
    } as unknown as ExtensionHost
    expect(await readProject(host, { project: 'blog', machine: 'desktop' }, 'trace', [])).toEqual({
      value: ['from desktop'],
    })
  } finally {
    server.close()
  }
})

it('names the machine when the project cannot be reached, and never offers a copy', () => {
  expect(() => resolveProject('poe2-rust', [here], register())).toThrow(
    'poe2-rust was last backed up from haza-pc, which registered no tailnet address',
  )
  expect(() => resolveProject('blog', [here], register())).toThrow(
    'Unknown project blog. Known: ultimate, poe2-rust',
  )
  expect(() => resolveProject('blog', [here], undefined)).toThrow('remotes in user settings')
  const stopped = { name: 'blog', root: '/p/blog', current: false }
  expect(() => resolveProject('blog', [here, stopped], register())).toThrow(
    'blog is not running on this machine; start it to query it',
  )
  const twice = [
    { name: 'poe2-rust', root: '/a/poe2-rust', current: false },
    { name: 'poe2-rust', root: '/b/poe2-rust', current: false },
  ]
  expect(() => resolveProject('poe2-rust', [here, ...twice], undefined)).toThrow(
    'poe2-rust names 2 projects on this machine: /a/poe2-rust, /b/poe2-rust; use its key',
  )
})
