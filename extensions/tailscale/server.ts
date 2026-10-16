import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
// oxlint-disable-next-line no-restricted-imports -- tailscale ownership uses the shared process lock and liveness check
import { acquireLock, alive } from '../../server/lock.ts'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ExtensionAction } from '../../server/actions.ts'

export type Status = {
  state:
    | 'disabled'
    | 'starting'
    | 'ready'
    | 'not-installed'
    | 'not-running'
    | 'not-operator'
    | 'https-disabled'
    | 'port-conflict'
    | 'error'
  url?: string
  allow: string[]
  hint?: string
}
interface Serve {
  TCP?: Record<string, unknown>
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
  AllowFunnel?: Record<string, boolean>
}
function target(serve: Serve, dns: string, port: number) {
  const authority = `${dns}:${port}`
  const handlers = serve.Web?.[authority]?.Handlers
  const proxy = handlers?.['/']?.Proxy
  if (
    serve.AllowFunnel?.[authority] ||
    Object.keys(handlers ?? {}).length !== 1 ||
    Object.keys(serve.Web ?? {}).some(
      (key) => key !== authority && Number(key.split(':').at(-1)) === port,
    )
  )
    return undefined
  return proxy && /^http:\/\/127\.0\.0\.1:\d+$/.test(proxy) ? proxy : undefined
}
export const reloadOnSettings = true
const run = promisify(execFile)
const statuses = new WeakMap<ExtensionHost, Status>()
const retries = new WeakMap<ExtensionHost, () => Promise<void>>()
export const actions: Record<string, ExtensionAction> = {
  status: async (_args, { host }): Promise<Status> =>
    statuses.get(host) ?? { state: 'disabled', allow: [] },
  /** Starts again unless ready, for example after fixing what a problem state names, and returns the new status. */
  retry: async (_args, { host }): Promise<Status> => {
    await retries.get(host)?.()
    return statuses.get(host) ?? { state: 'disabled', allow: [] }
  },
}

export default function tailscale(host: ExtensionHost) {
  let status: Status = { state: 'disabled', allow: [] }
  let cli = 'tailscale'
  let ownedPort: number | undefined
  let localTarget: string | undefined
  let dnsName: string | undefined
  const ownerToken = `${process.pid}:${randomUUID()}`
  const registryPath = join(host.userHome, '.ultimate/tailscale.json')
  let remove: (() => void) | undefined
  let opening: Promise<void> | undefined
  let running: Promise<void> | undefined
  let closed = false
  const set = (next: Status) => {
    status = next
    statuses.set(host, next)
  }
  const command = (args: string[]) => run(cli, args, { timeout: 15000, maxBuffer: 1024 * 1024 })
  const fail = (state: Status['state'], hint: string) => {
    set({ state, allow: status.allow, hint })
    host.notice(`Tailscale: ${hint}`)
  }
  async function withRegistry<T>(
    use: (value: { ports: Record<string, { port: number; owner: string }> }) => Promise<T>,
  ) {
    await mkdir(join(host.userHome, '.ultimate'), { recursive: true })
    const lock = await acquireLock(registryPath + '.lock', { pid: process.pid }, 120000).catch(
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
      let value: { ports: Record<string, { port: number; owner: string }> } = { ports: {} }
      try {
        value = JSON.parse(await readFile(registryPath, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
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
      const temporary = `${registryPath}.${process.pid}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
        await rename(temporary, registryPath)
      } finally {
        await rm(temporary, { force: true })
      }
      return result
    } finally {
      await lock.close()
    }
  }
  async function start() {
    if (ownedPort !== undefined || closed) return
    try {
      let settings: {
        extensions?: { disable?: string[] }
        tailscale?: { allow?: string[] }
      }
      try {
        settings = JSON.parse(
          await readFile(join(host.userHome, '.ultimate/settings.json'), 'utf8'),
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        settings = {}
      }
      if (settings.extensions?.disable?.includes('tailscale')) {
        fail(
          'disabled',
          '~/.ultimate/settings.json disables tailscale; project settings cannot enable remote access.',
        )
        return
      }
      set({ state: 'starting', allow: [] })
      let output: string
      try {
        output = (await command(['status', '--json'])).stdout
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        cli = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
        try {
          await access(cli, constants.X_OK)
        } catch {
          // On by default, so a machine without Tailscale gets a status, not a notice on every start.
          set({
            state: 'not-installed',
            allow: [],
            hint: 'Install Tailscale and put its CLI on PATH.',
          })
          return
        }
        output = (await command(['status', '--json'])).stdout
      }
      // Tailscale user IDs can exceed Number.MAX_SAFE_INTEGER; preserve the original numeric token.
      const node = JSON.parse(
        output,
        (key: string, value: unknown, context?: { source?: string }) =>
          key === 'UserID' && typeof value === 'number' ? context?.source : value,
      ) as {
        BackendState?: string
        Self?: { DNSName?: string; UserID?: string }
        User?: Record<string, { LoginName?: string }>
        CertDomains?: string[]
      }
      if (node.BackendState !== 'Running') {
        fail('not-running', 'Start Tailscale and log in (tailscale up).')
        return
      }
      const dns = node.Self?.DNSName?.replace(/\.$/, '')
      if (!dns) {
        fail(
          'error',
          'Tailscale is running but its DNS name is missing from status; check MagicDNS in the Tailscale admin console.',
        )
        return
      }
      const owner = node.Self?.UserID ? node.User?.[node.Self.UserID]?.LoginName : undefined
      if (!owner) {
        fail(
          'error',
          'Tailscale is running but its owner login is missing from status; check Self.UserID and User in tailscale status --json.',
        )
        return
      }
      const allow = settings.tailscale?.allow ?? [owner]
      if (!Array.isArray(allow) || allow.some((login) => typeof login !== 'string' || !login))
        throw new Error('tailscale.allow must be an array of login names')
      set({ state: 'starting', allow })
      if (!node.CertDomains?.includes(dns)) {
        fail('https-disabled', 'Enable HTTPS certificates in the Tailscale admin console.')
        return
      }
      const localPort = Number(new URL(host.system().process.url).port || '80')
      await withRegistry(async (registry) => {
        const serve = JSON.parse((await command(['serve', 'status', '--json'])).stdout) as Serve
        const live = new Set(
          (await host.projects()).flatMap((project) =>
            project.running ? [project.running.url] : [],
          ),
        )
        live.add(host.system().process.url)
        for (const entry of Object.values(registry.ports)) {
          const proxy = target(serve, dns, entry.port)
          if (proxy && !alive(Number(entry.owner.split(':')[0])) && !live.has(proxy)) {
            await command(['serve', `--https=${entry.port}`, 'off'])
            delete serve.Web?.[`${dns}:${entry.port}`]
            delete serve.TCP?.[String(entry.port)]
          }
        }
        const used = new Set([
          443,
          ...Object.values(registry.ports).map((entry) => entry.port),
          ...Object.keys(serve.TCP ?? {}).map(Number),
          ...Object.keys(serve.Web ?? {}).map((authority) => Number(authority.split(':').at(-1))),
        ])
        let port = registry.ports[host.projectRoot]?.port
        if (port !== undefined) {
          const mapping = serve.Web?.[`${dns}:${port}`]
          const ownTarget = target(serve, dns, port)
          if (
            Object.entries(registry.ports).some(
              ([root, assigned]) => root !== host.projectRoot && assigned.port === port,
            ) ||
            Object.keys(serve.Web ?? {}).some(
              (authority) =>
                authority !== `${dns}:${port}` && Number(authority.split(':').at(-1)) === port,
            ) ||
            serve.AllowFunnel?.[`${dns}:${port}`] ||
            (serve.TCP?.[String(port)] && !mapping) ||
            (mapping && !ownTarget)
          ) {
            fail(
              'port-conflict',
              `HTTPS port ${port} is used by a foreign mapping; resolve the conflict without changing other Serve mappings.`,
            )
            return
          }
        } else {
          port = used.has(localPort) ? 4747 : localPort
          while (used.has(port) && port <= 65535) port++
          if (port > 65535) {
            fail('port-conflict', 'No free HTTPS port; free an unused Serve port.')
            return
          }
        }
        await command([
          'serve',
          '--bg',
          '--yes',
          `--https=${port}`,
          `http://127.0.0.1:${localPort}`,
        ])
        registry.ports[host.projectRoot] = { port, owner: ownerToken }
        ownedPort = port
        localTarget = `http://127.0.0.1:${localPort}`
        dnsName = dns
        const url = `https://${dns}:${port}`
        remove = host.access.allow({
          origin: url,
          verify: ({ headers }) => {
            const login = headers['tailscale-user-login']
            return typeof login === 'string' && allow.includes(login) ? { login } : undefined
          },
        })
        set({ state: 'ready', url, allow })
      })
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? ''
      const message = String(stderr || error)
      if (/permission|access denied|not permitted|operator/i.test(stderr))
        fail('not-operator', 'Grant operator rights: sudo tailscale set --operator=$USER')
      else if (/not running|logged out|failed to connect|needslogin/i.test(stderr))
        fail('not-running', 'Start Tailscale and log in (tailscale up).')
      else fail('error', message.slice(0, 500))
    }
  }
  // One start at a time: a retry during a start waits for it, and once ready or closed, start does nothing.
  function begin() {
    running ??= start().finally(() => (running = undefined))
    return (opening = running)
  }
  // Faux servers are token-free demos and tests; they never change the machine's Serve mappings.
  if (host.faux) return defineExtension({ name: 'tailscale' })
  host.onOpen(begin)
  retries.set(host, begin)
  host.onClose(async () => {
    closed = true
    await opening
    remove?.()
    if (ownedPort !== undefined) {
      try {
        await withRegistry(async (value) => {
          if (value.ports[host.projectRoot]?.owner !== ownerToken) return
          const serve = JSON.parse((await command(['serve', 'status', '--json'])).stdout) as Serve
          if (target(serve, dnsName!, ownedPort!) === localTarget)
            await command(['serve', `--https=${ownedPort}`, 'off'])
        })
      } catch (error) {
        fail('error', `Could not remove Serve mapping: ${String(error)}`)
        return
      }
      ownedPort = undefined
    }
    set({ state: 'disabled', allow: status.allow })
  })
  set(status)
  return defineExtension({ name: 'tailscale' })
}
