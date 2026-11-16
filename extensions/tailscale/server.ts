import { randomUUID } from 'node:crypto'
import { acquireLock, alive } from '../../lib/lock.ts'
import { projectHome } from '../../lib/project-paths.ts'
import { access, mkdir } from 'node:fs/promises'
import { constants, existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineExtension } from '@earendil-works/pi-durable'
import { exec } from '../../lib/exec.ts'
import { isMissing } from '../../lib/errors.ts'
import { readJson, writeJson, writeTarget } from '../../lib/json-file.ts'
import { userSettingsPath } from '../../lib/settings.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ExtensionAction } from '../../server/actions.ts'
import { TailscaleApi } from './api.ts'
import type { Status } from './api.ts'
import { implementAction } from '../../lib/actions.ts'
import { RetryAction, StatusAction } from './refs.ts'
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
type RetainedProjectOrTemporaryPortClaim = { port: number; owner: string; temporary?: true }
export const reloadOnSettings = true
const statuses = new WeakMap<ExtensionHost, Status>()
const retries = new WeakMap<ExtensionHost, () => Promise<void>>()
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
}

export default function tailscale(host: ExtensionHost) {
  let status: Status = { state: 'disabled', allow: [] }
  const cliOverrideWithoutFallback = process.env.TAILSCALE_COMMAND
  let cli = cliOverrideWithoutFallback ?? 'tailscale'
  let ownedPort: number | undefined
  let localTarget: string | undefined
  let dnsName: string | undefined
  const ownerToken = `${process.pid}:${randomUUID()}`
  const registryPath = join(host.userHome, '.ultimate/tailscale.json')
  const temporaryHomeNeedsSeparatePort = host.home !== projectHome(host.projectRoot, host.userHome)
  const key = temporaryHomeNeedsSeparatePort ? host.home : host.projectRoot
  let remove: (() => void) | undefined
  let opening: Promise<void> | undefined
  let running: Promise<void> | undefined
  let closed = false
  const set = (next: Status) => {
    status = next
    statuses.set(host, next)
  }
  const command = (args: string[]) => exec(cli, args, { timeout: 15000, maxBuffer: 1024 * 1024 })
  const parsePreserving64BitUserIds = (output: string) =>
    JSON.parse(output, (property: string, value: unknown, context?: { source?: string }) =>
      property === 'UserID' && typeof value === 'number' ? context?.source : value,
    ) as {
      BackendState?: string
      Self?: { DNSName?: string; UserID?: string }
      User?: Record<string, { LoginName?: string }>
      CertDomains?: string[]
    }
  const ownerOf = (node: ReturnType<typeof parsePreserving64BitUserIds>) => {
    const login = node.Self?.UserID ? node.User?.[node.Self.UserID]?.LoginName : undefined
    return login ? [login] : undefined
  }
  const fail = (state: Status['state'], hint: string) => {
    set({ state, allow: status.allow, hint })
    host.notice(`Tailscale: ${hint}`)
  }
  async function withRegistry<T>(
    use: (value: { ports: Record<string, RetainedProjectOrTemporaryPortClaim> }) => Promise<T>,
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
      const value = await readJson<{ ports: Record<string, RetainedProjectOrTemporaryPortClaim> }>(
        registryPath,
        { ports: {} },
      )
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
  let ready: Status | undefined
  let sharedOwnerLoginRead: ReturnType<typeof command> | undefined
  const intact = () =>
    withRegistry(async (registry) => {
      const owner = registry.ports[key]?.owner
      if (owner !== ownerToken && owner && alive(Number(owner.split(':')[0]))) return 'successor'
      const serve = JSON.parse((await command(['serve', 'status', '--json'])).stdout) as Serve
      return owner === ownerToken && target(serve, dnsName!, ownedPort!) === localTarget
        ? 'own'
        : undefined
    })
  async function start() {
    if (closed) return
    try {
      if (ownedPort !== undefined) {
        const mapping = await intact()
        if (mapping === 'own') set(ready!)
        if (mapping) return
        remove?.()
        ownedPort = undefined
      }
      const settings = await readJson<{ tailscale?: { allow?: string[] } }>(
        userSettingsPath(host.userHome),
        {},
      )
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
            hint: 'Install Tailscale and put its CLI on PATH.',
          })
          return
        }
        output = (await command(['status', '--json'])).stdout
      }
      const node = parsePreserving64BitUserIds(output)
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
      let allow = settings.tailscale?.allow ?? ownerOf(node)
      if (
        allow &&
        (!Array.isArray(allow) || allow.some((login) => typeof login !== 'string' || !login))
      )
        throw new Error('tailscale.allow must be an array of login names')
      set({ state: 'starting', allow: allow ?? [] })
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
        for (const [name, entry] of Object.entries(registry.ports)) {
          const proxy = target(serve, dns, entry.port)
          const dead = !alive(Number(entry.owner.split(':')[0]))
          if (proxy && dead && !live.has(proxy)) {
            await command(['serve', `--https=${entry.port}`, 'off'])
            delete serve.Web?.[`${dns}:${entry.port}`]
            delete serve.TCP?.[String(entry.port)]
          }
          const deadTemporaryOrRemovedProject =
            dead && name !== key && (entry.temporary || !existsSync(name))
          if (deadTemporaryOrRemovedProject) delete registry.ports[name]
        }
        const used = new Set([
          443,
          ...Object.values(registry.ports).map((entry) => entry.port),
          ...Object.keys(serve.TCP ?? {}).map(Number),
          ...Object.keys(serve.Web ?? {}).map((authority) => Number(authority.split(':').at(-1))),
        ])
        let port = registry.ports[key]?.port
        if (port !== undefined) {
          const mapping = serve.Web?.[`${dns}:${port}`]
          const ownTarget = target(serve, dns, port)
          if (
            Object.entries(registry.ports).some(
              ([root, assigned]) => root !== key && assigned.port === port,
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
        registry.ports[key] = {
          port,
          owner: ownerToken,
          ...(temporaryHomeNeedsSeparatePort && { temporary: true as const }),
        }
        ownedPort = port
        localTarget = `http://127.0.0.1:${localPort}`
        dnsName = dns
        const url = `https://${dns}:${port}`
        remove = host.access.allow({
          origin: url,
          verify: async ({ headers }) => {
            const login = headers['tailscale-user-login']
            if (typeof login !== 'string') return undefined
            if (!allow) {
              sharedOwnerLoginRead ??= command(['status', '--json']).finally(
                () => (sharedOwnerLoginRead = undefined),
              )
              allow ??= ownerOf(parsePreserving64BitUserIds((await sharedOwnerLoginRead).stdout))
              if (allow) ready = { state: 'ready', url, allow }
              if (allow && status.state === 'ready') set(ready!)
            }
            return allow?.includes(login) ? { login } : undefined
          },
        })
        ready = allow
          ? { state: 'ready', url, allow }
          : {
              state: 'ready',
              url,
              allow: [],
              hint: 'No one can open it yet: tailscale status --json does not list the owner login (Self.UserID in User). It is read again on the next tailnet request.',
            }
        set(ready)
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
    remove?.()
    if (ownedPort !== undefined) {
      try {
        await withRegistry(async (value) => {
          if (value.ports[key]?.owner !== ownerToken) return
          const serve = JSON.parse((await command(['serve', 'status', '--json'])).stdout) as Serve
          if (target(serve, dnsName!, ownedPort!) === localTarget)
            await command(['serve', `--https=${ownedPort}`, 'off'])
          if (temporaryHomeNeedsSeparatePort) delete value.ports[key]
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
