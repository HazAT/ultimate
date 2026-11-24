import { randomUUID } from 'node:crypto'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders, Server, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { access, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { defineExtension } from '@earendil-works/pi-durable'
import { acquireLock, alive } from '../../lib/lock.ts'
import { projectHome } from '../../lib/project-paths.ts'
import { exec } from '../../lib/exec.ts'
import { errnoCode, inProcess, isMissing, meansNone } from '../../lib/errors.ts'
import { readJson, writeJson, writeTarget } from '../../lib/json-file.ts'
import { userSettingsPath } from '../../lib/settings.ts'
import { implementAction } from '../../lib/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ExtensionAction } from '../../server/actions.ts'
import { TailscaleApi } from '../tailscale/api.ts'
import { AllowAction, PeersAction, RetryAction, StatusAction } from './refs.ts'
import type { MeshPeers, Status } from './refs.ts'

type RegistryClaim = { port: number; owner: string; temporary?: true }
type MeshSettings = { allow?: string[]; bind?: string }
type NodeEntry = { HostName?: string; DNSName?: string; TailscaleIPs?: string[]; Online?: boolean }
type MeshNode = { BackendState?: string; Self?: NodeEntry } & { Peer?: Record<string, NodeEntry> }
const stripDot = (name: string) => name.replace(/\.$/, '')
const forwardedHeaders = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded']
const allowActionPath = '/api/extensions/headscale/actions/allow'

const meshPeerOf = (node: MeshNode, remote: string | undefined): NodeEntry | undefined => {
  const ip = remote?.replace(/^::ffff:/, '') ?? ''
  if (!isIP(ip)) return undefined
  if (['127.0.0.1', '::1'].includes(ip)) return node.Self
  return [node.Self, ...Object.values(node.Peer ?? {})].find((entry) =>
    entry?.TailscaleIPs?.includes(ip),
  )
}
const meshAllows = (allow: string[], entry: NodeEntry) => {
  const names = [
    entry.DNSName ? stripDot(entry.DNSName) : undefined,
    entry.HostName,
    ...(entry.TailscaleIPs ?? []),
  ]
    .filter((name): name is string => typeof name === 'string' && name !== '')
    .map((name) => name.toLowerCase())
  return allow.some((value) => value !== '' && names.includes(stripDot(value).toLowerCase()))
}
const meshIdentity = (entry: NodeEntry) =>
  entry.DNSName ? stripDot(entry.DNSName) : (entry.HostName ?? '')
const meshHeaders = (
  received: IncomingHttpHeaders,
  peer: NodeEntry,
  remote: string | undefined,
) => {
  const headers = { ...received }
  for (const name of forwardedHeaders) delete headers[name]
  headers['tailscale-user-login'] = meshIdentity(peer)
  headers['x-forwarded-for'] = remote
  headers['x-forwarded-proto'] = 'http'
  return headers
}

export const reloadOnSettings = true
const statuses = new WeakMap<ExtensionHost, Status>()
const retries = new WeakMap<ExtensionHost, () => Promise<void>>()
type MeshPicker = {
  peers: () => Promise<MeshPeers>
  setAllow: (next: unknown) => Promise<Status>
}
const pickers = new WeakMap<ExtensionHost, MeshPicker>()
export const actions: Record<string, ExtensionAction> = {
  status: implementAction(
    StatusAction,
    async (_args, { host }): Promise<Status> =>
      statuses.get(host) ?? { state: 'disabled', allow: [] },
  ),
  retry: implementAction(RetryAction, async (_args, { host }): Promise<Status> => {
    await retries.get(host)?.()
    return statuses.get(host) ?? { state: 'disabled', allow: [] }
  }),
  peers: implementAction(
    PeersAction,
    async (_args, { host }): Promise<MeshPeers> =>
      (await pickers.get(host)?.peers()) ?? { peers: [] },
  ),
  allow: implementAction(AllowAction, async (args, { host }): Promise<Status> => {
    const picker = pickers.get(host)
    if (!picker)
      throw new Error('No mesh listener to configure yet; fix what the status reports and retry.')
    const allow = args && typeof args === 'object' && !Array.isArray(args) ? args.allow : undefined
    return picker.setAllow(allow)
  }),
}

export default function headscale(host: ExtensionHost) {
  let status: Status = { state: 'disabled', allow: [] }
  const cliOverrideWithoutFallback = process.env.TAILSCALE_COMMAND
  let cli = cliOverrideWithoutFallback ?? 'tailscale'
  const ownerToken = `${process.pid}:${randomUUID()}`
  const registryPath = join(host.userHome, '.ultimate/tailscale.json')
  const temporaryHomeNeedsSeparatePort = host.home !== projectHome(host.projectRoot, host.userHome)
  const key = temporaryHomeNeedsSeparatePort ? host.home : host.projectRoot
  let remove: (() => void) | undefined
  let opening: Promise<void> | undefined
  let running: Promise<void> | undefined
  let closed = false
  let ready: Status | undefined
  const set = (next: Status) => {
    status = next
    statuses.set(host, next)
  }
  const command = (args: string[]) => exec(cli, args, { timeout: 15000, maxBuffer: 1024 * 1024 })
  const fail = (state: Status['state'], hint: string) => {
    set({ state, allow: status.allow, hint })
    host.notice(`Headscale: ${hint}`)
  }
  async function withRegistry<T>(
    use: (value: { ports: Record<string, RegistryClaim> }) => Promise<T>,
  ) {
    await mkdir(join(host.userHome, '.ultimate'), { recursive: true })
    const sharedRegistryTargetLock = (await writeTarget(registryPath)) + '.lock'
    const lock = await acquireLock(sharedRegistryTargetLock, { pid: process.pid }, 120000).catch(
      (error) => {
        if (
          error instanceof Error &&
          error.message.startsWith('Ultimate core already owns this storage')
        )
          throw new Error(
            `Tailscale port registry is busy (${registryPath}); wait for the current instance to finish and retry. Dead owners are recovered automatically.`,
            { cause: error },
          )
        throw error
      },
    )
    try {
      const value = await readJson<{ ports: Record<string, RegistryClaim> }>(registryPath, {
        ports: {},
      })
      if (
        !value.ports ||
        Object.values(value.ports).some(
          (entry) =>
            !Number.isInteger(entry.port) ||
            entry.port < 1 ||
            entry.port > 65535 ||
            entry.port === 443 ||
            !/^\d+:.+/.test(entry.owner),
        )
      )
        throw new Error('Invalid ~/.ultimate/tailscale.json port registry')
      const result = await use(value)
      await writeJson(registryPath, value, { mode: 0o600 })
      return result
    } finally {
      await lock.close()
    }
  }
  let mesh: { server: Server; port: number; localPort: number; dns: string } | undefined
  let meshCache: { at: number; node: MeshNode } | undefined
  let meshRead: Promise<MeshNode> | undefined
  const meshNode = async (fresh = false) => {
    if (!fresh && meshCache && Date.now() - meshCache.at < 30000) return meshCache.node
    meshRead ??= command(['status', '--json'])
      .then((output) => {
        const node = JSON.parse(output.stdout) as MeshNode
        meshCache = { at: Date.now(), node }
        return node
      })
      .finally(() => (meshRead = undefined))
    return meshRead
  }
  const freeMeshPort = (bind: string, first: number) =>
    new Promise<number>((resolve, reject) => {
      const probe = (port: number) => {
        if (port > 65535) return reject(new Error('No free mesh port'))
        const server = createHttpServer()
        server.once('error', (error) =>
          errnoCode(error) === 'EADDRINUSE' ? probe(port + 1) : reject(error),
        )
        server.listen(port, bind, () => server.close(() => resolve(port)))
      }
      probe(first)
    })
  const meshForbidden = (response: ServerResponse) => {
    response.writeHead(403)
    response.end('Forbidden')
  }
  const meshAdmitted = async (
    received: IncomingHttpHeaders,
    remote: string | undefined,
    allow: string[],
  ) => {
    const admitted = (node: MeshNode | undefined) => {
      const peer = node && meshPeerOf(node, remote)
      return peer && meshAllows(allow, peer) ? meshHeaders(received, peer, remote) : undefined
    }
    const cached = await meshNode().catch(meansNone)
    return cached && meshPeerOf(cached, remote)
      ? admitted(cached)
      : admitted(await meshNode(true).catch(meansNone))
  }
  async function start() {
    if (closed) return
    if (mesh?.server.listening) {
      set(ready!)
      return
    }
    try {
      set({ state: 'starting', allow: [] })
      let output: string
      try {
        output = (await command(['status', '--json'])).stdout
      } catch (error) {
        if (!isMissing(error)) throw error
        try {
          if (cliOverrideWithoutFallback) throw error
          cli = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
          await access(cli, constants.X_OK)
        } catch {
          set({
            state: 'not-installed',
            allow: [],
            hint: 'Install the Tailscale CLI (it drives a Headscale tailnet too) and put it on PATH.',
          })
          return
        }
        output = (await command(['status', '--json'])).stdout
      }
      const node = JSON.parse(output) as MeshNode
      if (node.BackendState !== 'Running') {
        fail('not-running', 'Start Tailscale and log in (tailscale up --login-server …).')
        return
      }
      const dns = node.Self?.DNSName && stripDot(node.Self.DNSName)
      if (!dns) {
        fail(
          'error',
          'Tailscale is running but its DNS name is missing from status; check MagicDNS in the Headscale config.',
        )
        return
      }
      const settings = await readJson<{ headscale?: MeshSettings }>(
        userSettingsPath(host.userHome),
        {},
      )
      let allow = settings.headscale?.allow ?? [dns]
      if (!Array.isArray(allow) || allow.some((name) => typeof name !== 'string' || !name))
        throw new Error('headscale.allow must be an array of node names or mesh addresses')
      const localPort = Number(new URL(host.system().process.url).port || '80')
      const bind = settings.headscale?.bind ?? node.Self?.TailscaleIPs?.find((ip) => isIP(ip) === 4)
      if (!bind) {
        fail('error', 'Status lists no Tailscale IP to bind the mesh listener on.')
        return
      }
      if (!isIP(bind) || bind === '0.0.0.0' || bind === '::') {
        fail('error', `headscale.bind must be one address of this node, not ${bind}.`)
        return
      }
      const assigned = await withRegistry(async (registry) => {
        const entry = registry.ports[key]
        const owner = Number(entry?.owner.split(':')[0])
        if (entry && owner !== process.pid && alive(owner))
          throw new Error(`Mesh port ${entry.port} is owned by another running instance`)
        return entry?.port
      })
      const server = createHttpServer((clientReq, clientRes) => {
        inProcess(
          'a mesh proxy request: the response dies with the process',
          (async () => {
            if (clientReq.url?.split('?')[0] === allowActionPath) return meshForbidden(clientRes)
            const headers = await meshAdmitted(
              clientReq.headers,
              clientReq.socket.remoteAddress,
              allow,
            ).catch(meansNone)
            if (!headers) return meshForbidden(clientRes)
            const upstream = httpRequest({
              host: '127.0.0.1',
              port: localPort,
              path: clientReq.url,
              method: clientReq.method,
              headers,
            })
            upstream.on('response', (upstreamRes) => {
              clientRes.writeHead(upstreamRes.statusCode!, upstreamRes.headers)
              upstreamRes.pipe(clientRes)
            })
            upstream.on('error', () => {
              if (!clientRes.headersSent) {
                clientRes.writeHead(502)
                clientRes.end()
              } else clientRes.destroy()
            })
            clientReq.pipe(upstream)
          })(),
        )
      })
      const listen = (candidate: number) =>
        new Promise<number>((resolve, reject) =>
          server.once('error', reject).listen(candidate, bind, () => resolve(candidate)),
        )
      const port = await (
        assigned !== undefined ? listen(assigned) : Promise.reject('unassigned')
      ).catch(async (error: unknown) => {
        if (assigned !== undefined && errnoCode(error) !== 'EADDRINUSE') throw error
        return listen(await freeMeshPort(bind, localPort === 443 ? 4747 : localPort))
      })
      mesh = { server, port, localPort, dns }
      await withRegistry(async (registry) => {
        registry.ports[key] = {
          port,
          owner: ownerToken,
          ...(temporaryHomeNeedsSeparatePort && { temporary: true as const }),
        }
      })
      const url = `http://${dns}:${port}`
      const address = isIP(bind) === 6 ? `[${bind}]` : bind
      const meshUrl = `http://${address}:${port}`
      const verify = async ({ headers }: { headers: IncomingHttpHeaders }) => {
        const login = headers['tailscale-user-login']
        if (typeof login !== 'string' || !login) return undefined
        const current = (await meshNode().catch(meansNone)) ?? {}
        const peer = [current.Self, ...Object.values(current.Peer ?? {})].find(
          (entry) => entry && meshIdentity(entry) === login,
        )
        return peer && meshAllows(allow, peer) ? { login } : undefined
      }
      const registered = [url, meshUrl].map((origin) => host.access.allow({ origin, verify }))
      remove = () => registered.forEach((unregister) => unregister())
      ready = { state: 'ready', url, meshUrl, allow }
      if (!settings.headscale?.allow)
        ready = {
          ...ready,
          hint: `Only this node can open it yet: pick the nodes to allow, or add their names or mesh addresses to headscale.allow (this node is ${dns}).`,
        }
      pickers.set(host, {
        peers: async () => {
          const current = (await meshNode().catch(meansNone)) ?? {}
          const entries = [
            ...(current.Self ? [{ entry: current.Self, self: true }] : []),
            ...Object.values(current.Peer ?? {})
              .filter((entry): entry is NodeEntry => Boolean(entry))
              .map((entry) => ({ entry, self: false })),
          ]
          return {
            peers: entries.map(({ entry, self }) => ({
              name: meshIdentity(entry) || entry.TailscaleIPs?.[0] || '',
              ips: entry.TailscaleIPs ?? [],
              self,
              online: self || entry.Online !== false,
              allowed: meshAllows(allow, entry),
            })),
          }
        },
        setAllow: async (next: unknown) => {
          if (!Array.isArray(next) || next.some((name) => typeof name !== 'string' || !name))
            throw new Error('headscale.allow must be an array of node names or mesh addresses')
          const settingsPath = userSettingsPath(host.userHome)
          const current = await readJson<{ headscale?: MeshSettings & Record<string, unknown> }>(
            settingsPath,
            {},
          )
          await writeJson(settingsPath, {
            ...current,
            headscale: { ...current.headscale, allow: next },
          })
          return status
        },
      })
      set(ready)
    } catch (error) {
      meshCache = undefined
      if (mesh) {
        mesh.server.closeAllConnections()
        await new Promise<void>((resolve) => mesh!.server.close(() => resolve()))
        mesh = undefined
      }
      const message = String((error as { stderr?: string }).stderr || error)
      if (/EACCES|EPERM/i.test(message))
        fail(
          'error',
          'Binding the mesh address needs rights this process lacks; run as root or pick another bind address.',
        )
      else if (/owned by another running instance|No free mesh port/.test(message))
        fail('port-conflict', message.slice(0, 500))
      else if (/not running|logged out|failed to connect|needslogin/i.test(message))
        fail('not-running', 'Start Tailscale and log in (tailscale up --login-server …).')
      else fail('error', message.slice(0, 500))
    }
  }
  function startOrJoinCurrentRepair() {
    running ??= start().finally(() => (running = undefined))
    return (opening = running)
  }
  host.onOpen(startOrJoinCurrentRepair)
  retries.set(host, startOrJoinCurrentRepair)
  host.implement(TailscaleApi, { status: () => status })
  host.onClose(async () => {
    closed = true
    await opening
    if (mesh) {
      const listening = mesh.server.listening
      mesh.server.closeAllConnections()
      await new Promise<void>((resolve) => mesh!.server.close(() => resolve()))
      await withRegistry(async (value) => {
        if (listening && value.ports[key]?.owner === ownerToken) delete value.ports[key]
      }).catch((error) => fail('error', `Could not free the mesh port: ${String(error)}`))
      mesh = undefined
    }
    remove?.()
    set({ state: 'disabled', allow: status.allow })
  })
  set(status)
  return defineExtension({ name: 'headscale' })
}
