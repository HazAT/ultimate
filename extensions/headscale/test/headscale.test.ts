import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import headscale, { actions } from '../server.ts'
import type { Status } from '../refs.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { admit, createAccess } from '../../../server/request-security.ts'
import { projectHome } from '../../../lib/project-paths.ts'
import { temp, until } from '../../../test/helpers.ts'

// Loopback aliases stand in for the nodes' mesh addresses: connections from them map to peers exactly as WireGuard
// source addresses do in production, without the test needing a real tailnet interface.
const selfAddress = '127.0.0.1'
const peerBAddress = '127.0.0.3'
const peerCAddress = '127.0.0.4'
const unknownAddress = '127.0.0.9'
const bind = '127.0.0.5'
const dns = 'node-a.tail.example.com'
const peerB = 'node-b.tail.example.com'
const peerC = 'node-c.tail.example.com'
const node = {
  BackendState: 'Running',
  Self: { HostName: 'node-a', DNSName: `${dns}.`, TailscaleIPs: ['100.64.0.1'], Online: true },
  Peer: {
    '100.64.0.2': {
      HostName: 'node-b',
      DNSName: `${peerB}.`,
      TailscaleIPs: ['100.64.0.2', peerBAddress],
      Online: true,
    },
    '100.64.0.3': {
      HostName: 'node-c',
      DNSName: `${peerC}.`,
      TailscaleIPs: ['100.64.0.3', peerCAddress],
      Online: false,
    },
  },
}

const closes: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closes.splice(0)) await close()
  vi.unstubAllEnvs()
})

// Opens the extension without waiting for a status: handoff tests drive the start themselves.
async function setup(settings: Record<string, unknown> = {}) {
  const home = await temp()
  await mkdir(join(home, '.ultimate'))
  await writeFile(join(home, '.ultimate/settings.json'), JSON.stringify(settings))
  const nodeJson = join(home, 'node.json')
  const log = join(home, 'argv.jsonl')
  await writeFile(nodeJson, JSON.stringify(node))
  const script = join(home, 'tailscale')
  await writeFile(
    script,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args.join(' ') === 'status --json') process.stdout.write(fs.readFileSync(${JSON.stringify(nodeJson)}, 'utf8'));
else { console.error('unexpected args: ' + args.join(' ')); process.exit(1); }
`,
  )
  await chmod(script, 0o755)
  // This file runs its own stub CLI from PATH, not the missing one test/setup.ts names for every other server.
  vi.stubEnv('TAILSCALE_COMMAND', undefined)
  vi.stubEnv('PATH', process.platform === 'darwin' ? `${home}:/bin` : home)
  const invocations = async () => {
    try {
      return (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[])
    } catch {
      return []
    }
  }
  // A stand-in for the loopback-only supervisor: the real admission rules decide what a proxied request may do.
  const seen: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[] = []
  const access = createAccess()
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', async () => {
      seen.push({
        method: request.method!,
        url: request.url!,
        headers: request.headers,
        body: Buffer.concat(chunks).toString(),
      })
      const admitted = await admit(request, String(localPort), access.rules)
      response.writeHead(admitted ? 200 : 403)
      response.end(admitted ? 'admitted' : 'Forbidden')
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, selfAddress, resolve))
  const localPort = (upstream.address() as { port: number }).port
  closes.push(
    async () =>
      new Promise<void>((resolve) => {
        upstream.closeAllConnections()
        upstream.close(() => resolve())
      }),
  )
  const openers: (() => Promise<void>)[] = []
  const cleanups: (() => Promise<void>)[] = []
  const host = {
    userHome: home,
    home: projectHome('/project/a', home),
    projectRoot: '/project/a',
    access,
    notice: () => {},
    system: () => ({ process: { url: `http://127.0.0.1:${localPort}` } }),
    onOpen: (fn: () => Promise<void>) => openers.push(fn),
    onClose: (fn: () => Promise<void>) => cleanups.push(fn),
    implement: () => {},
  } as unknown as ExtensionHost
  headscale(host)
  closes.push(async () => {
    for (const fn of cleanups) await fn()
  })
  const status = async () =>
    (await actions.status(null, { host } as Parameters<typeof actions.status>[1])) as Status
  return {
    home,
    host,
    localPort,
    invocations,
    seen,
    status,
    open: () => Promise.all(openers.map((fn) => fn())),
  }
}

// A ready listener: the mesh URL's port and a request helper aimed at it.
async function fixture(settings: Record<string, unknown> = {}) {
  const opened = await setup(settings)
  await opened.open()
  await until(async () => (await opened.status()).state === 'ready')
  const port = new URL((await opened.status()).url!).port
  const request = (
    path: string,
    headers: IncomingHttpHeaders = {},
    from = peerBAddress,
    method = 'GET',
    body?: string,
  ) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const sent = httpRequest(
        { host: bind, port: Number(port), path, method, headers, localAddress: from },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () =>
            resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }),
          )
        },
      )
      sent.on('error', reject)
      sent.end(body)
    })
  return { ...opened, port, request }
}

it('admits an allowed peer, maps its identity, and strips the forwarding headers the client sent', async () => {
  const f = await fixture({ headscale: { allow: [peerB], bind } })
  const headers = {
    host: `${dns}:${f.port}`,
    'x-forwarded-for': '203.0.113.9',
    'x-forwarded-host': 'attacker.example',
    'x-forwarded-proto': 'https',
    forwarded: 'for=203.0.113.9',
  }
  expect(await f.request('/api/system', headers)).toEqual({ status: 200, body: 'admitted' })
  expect(f.seen).toHaveLength(1)
  expect(f.seen[0].headers).toMatchObject({
    host: `${dns}:${f.port}`,
    'tailscale-user-login': peerB,
    'x-forwarded-for': peerBAddress,
    'x-forwarded-proto': 'http',
  })
  expect(f.seen[0].headers.forwarded).toBeUndefined()
  expect(f.seen[0].headers['x-forwarded-host']).toBeUndefined()
})

it('refuses a peer the tailnet does not know, and one the allowlist does not name', async () => {
  const f = await fixture({ headscale: { allow: [peerB], bind } })
  expect(await f.request('/', {}, unknownAddress)).toEqual({ status: 403, body: 'Forbidden' })
  expect(await f.request('/', {}, peerCAddress)).toEqual({ status: 403, body: 'Forbidden' })
  expect(f.seen).toEqual([])
})

it('leaves the supervisor admission rules in charge of Origin and fetch metadata', async () => {
  const f = await fixture({ headscale: { allow: [peerB], bind } })
  expect(
    await f.request('/api/system', {
      host: `${dns}:${f.port}`,
      origin: `http://${dns}:${f.port}`,
      'sec-fetch-site': 'same-origin',
    }),
  ).toEqual({ status: 200, body: 'admitted' })
  expect(
    await f.request('/api/system', {
      host: `${dns}:${f.port}`,
      origin: 'https://attacker.example',
      'sec-fetch-site': 'cross-site',
    }),
  ).toEqual({ status: 403, body: 'Forbidden' })
  // The mesh listener's own address is a registered origin too, for peers whose MagicDNS does not resolve.
  expect(
    await f.request('/api/system', {
      host: `${bind}:${f.port}`,
      origin: `http://${bind}:${f.port}`,
      'sec-fetch-site': 'same-origin',
    }),
  ).toEqual({ status: 200, body: 'admitted' })
})

it('re-reads the peer map once for an unknown address and never for a known one', async () => {
  const f = await fixture({ headscale: { allow: [peerB], bind } })
  const statusReads = async () =>
    (await f.invocations()).filter((args) => args.join(' ') === 'status --json')
  await f.request('/')
  await f.request('/')
  expect(await statusReads()).toHaveLength(2)
  await f.request('/', {}, unknownAddress)
  expect(await statusReads()).toHaveLength(3)
})

it('never forwards the allowlist write through the mesh, and keeps it a loopback-only settings edit', async () => {
  const f = await fixture({ headscale: { allow: [peerB], bind }, sounds: { volume: 0.4 } })
  expect(
    await f.request('/api/extensions/headscale/actions/allow', {}, peerBAddress, 'POST', '{}'),
  ).toEqual({ status: 403, body: 'Forbidden' })
  expect(f.seen).toEqual([])
  await actions.allow({ allow: [peerB, peerC] }, { host: f.host } as Parameters<
    typeof actions.allow
  >[1])
  expect(JSON.parse(await readFile(join(f.home, '.ultimate/settings.json'), 'utf8'))).toEqual({
    headscale: { allow: [peerB, peerC], bind },
    sounds: { volume: 0.4 },
  })
})

it('lists the tailnet with both URL forms and who may connect', async () => {
  const f = await fixture({ headscale: { bind } })
  expect(await f.status()).toMatchObject({
    state: 'ready',
    url: `http://${dns}:${f.port}`,
    meshUrl: `http://${bind}:${f.port}`,
    allow: [dns],
  })
  expect(
    await actions.peers(null, { host: f.host } as Parameters<typeof actions.peers>[1]),
  ).toEqual({
    peers: [
      { name: dns, ips: ['100.64.0.1'], self: true, online: true, allowed: true },
      { name: peerB, ips: ['100.64.0.2', peerBAddress], self: false, online: true, allowed: false },
      {
        name: peerC,
        ips: ['100.64.0.3', peerCAddress],
        self: false,
        online: false,
        allowed: false,
      },
    ],
  })
})

// A core swap briefly overlaps two generations: the dying one keeps the registry entry and the port until its
// close finishes, moments after the successor starts. The registry key a default home registers under.
const registryKey = '/project/a'

it('waits out a core swap and takes the stable port once the dying generation releases it', async () => {
  const opened = await setup({ headscale: { allow: [peerB], bind } })
  const predecessor = createServer()
  await new Promise<void>((resolve) => predecessor.listen(opened.localPort, bind, resolve))
  closes.push(async () => new Promise<void>((resolve) => predecessor.close(() => resolve())))
  const registry = join(opened.home, '.ultimate/tailscale.json')
  const heldByLiveOwner = JSON.stringify(
    { ports: { [registryKey]: { port: opened.localPort, owner: '1:predecessor' } } },
    null,
    2,
  )
  await writeFile(registry, heldByLiveOwner + '\n')
  const seeded = (await stat(registry)).mtimeMs
  const starting = opened.open()
  // Every registry poll rewrites the file, so the first rewrite proves the successor saw the held entry and
  // chose to wait instead of reporting a conflict.
  await until(
    async () => ((await stat(registry).catch(() => undefined))?.mtimeMs ?? seeded) !== seeded,
  )
  // The dying generation closes exactly as the real one does: the socket first, then the registry entry.
  await new Promise<void>((resolve) => predecessor.close(() => resolve()))
  await writeFile(registry, JSON.stringify({ ports: {} }, null, 2) + '\n')
  await starting
  expect(await opened.status()).toMatchObject({ state: 'ready' })
  expect(new URL((await opened.status()).url!).port).toBe(String(opened.localPort))
})

it('reports port-conflict only when a live holder outlives the handoff window', async () => {
  vi.stubEnv('ULTIMATE_HEADSCALE_HANDOFF_MS', '300')
  const opened = await setup({ headscale: { allow: [peerB], bind } })
  const holder = createServer()
  await new Promise<void>((resolve) => holder.listen(opened.localPort, bind, resolve))
  closes.push(async () => new Promise<void>((resolve) => holder.close(() => resolve())))
  await writeFile(
    join(opened.home, '.ultimate/tailscale.json'),
    JSON.stringify(
      { ports: { [registryKey]: { port: opened.localPort, owner: '1:never-releases' } } },
      null,
      2,
    ) + '\n',
  )
  await opened.open()
  expect(await opened.status()).toMatchObject({
    state: 'port-conflict',
    hint: expect.stringMatching(/owned by another running instance/),
  })
})
