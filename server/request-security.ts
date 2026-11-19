import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import { BlockList, isIP } from 'node:net'
import type { Device, UiSource } from '../shared/events.ts'
import { SOURCE_HEADER } from '../shared/protocol.ts'
import { meansNone } from '../lib/errors.ts'

export interface AccessRule {
  origin: string
  verify(request: {
    headers: IncomingHttpHeaders
  }):
    | { login: string; name?: string }
    | undefined
    | Promise<{ login: string; name?: string } | undefined>
}

export function createAccess(changed: () => void = () => {}) {
  const rules = new Set<AccessRule>()
  return {
    rules,
    origins: () => [...new Set([...rules].map((rule) => rule.origin))],
    allow(rule: AccessRule) {
      const url = new URL(rule.origin)
      if (!['https:', 'http:'].includes(url.protocol) || url.origin !== rule.origin)
        throw new Error('Access requires a full HTTP origin')
      rules.add(rule)
      changed()
      return () => {
        if (rules.delete(rule)) changed()
      }
    },
  }
}
export type Access = ReturnType<typeof createAccess>

export async function admit(
  request: Pick<IncomingMessage, 'headers' | 'method' | 'url'>,
  port: string,
  rules: Set<AccessRule>,
) {
  const { host, origin } = request.headers
  if (
    !proxied(request.headers) &&
    loopbackAuthority(host, port) &&
    (!origin || loopbackOrigin(origin, port))
  )
    return true
  const site = request.headers['sec-fetch-site']
  const viewOnlyRootNavigation =
    (site === 'cross-site' || site === 'same-site') &&
    request.method === 'GET' &&
    (request.url === '/' || request.url?.startsWith('/?') === true) &&
    request.headers['sec-fetch-mode'] === 'navigate' &&
    request.headers['sec-fetch-dest'] === 'document' &&
    request.headers.upgrade === undefined
  if (site !== undefined && site !== 'same-origin' && site !== 'none' && !viewOnlyRootNavigation)
    return false
  for (const rule of rules) {
    if (host !== new URL(rule.origin).host || (origin && origin !== rule.origin)) continue
    try {
      if ((await rule.verify(request))?.login && rules.has(rule)) return true
    } catch (error) {
      meansNone(error)
    }
  }
  return false
}

const tailscaleCgnatAndUlaRanges = new BlockList()
tailscaleCgnatAndUlaRanges.addSubnet('100.64.0.0', 10, 'ipv4')
tailscaleCgnatAndUlaRanges.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6')

export function sourceOf(headers: IncomingHttpHeaders): UiSource {
  return {
    source:
      headers[SOURCE_HEADER] === 'agent'
        ? 'agent'
        : headers[SOURCE_HEADER] === 'app'
          ? 'app'
          : 'person',
  }
}

export function deviceOf(headers: IncomingHttpHeaders): Device {
  const agent = headers['user-agent'] ?? ''
  const kind = /Mobi|iPhone|Android/.test(agent) ? 'phone' : 'desktop'
  const browser = /Edg\//.test(agent)
    ? 'edge'
    : /Firefox|FxiOS/.test(agent)
      ? 'firefox'
      : /Chrome|CriOS/.test(agent)
        ? 'chrome'
        : /Safari/.test(agent)
          ? 'safari'
          : 'other'
  const login = headers['tailscale-user-login']
  if (!proxied(headers) || typeof login !== 'string' || !login)
    return { device: `${kind} ${browser}` }
  const address = lastProxyVouchedTailnetAddress(headers['x-forwarded-for'])
  return { device: `${kind} ${browser}`, login, ...(address ? { address } : {}) }
}

function lastProxyVouchedTailnetAddress(header: string | string[] | undefined) {
  const address = [header ?? []].flat().join(',').split(',').at(-1)?.trim() ?? ''
  const family = isIP(address)
  if (!family) return undefined
  return tailscaleCgnatAndUlaRanges.check(address, family === 4 ? 'ipv4' : 'ipv6')
    ? address
    : undefined
}

export function proxied(headers: IncomingHttpHeaders) {
  return ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded'].some(
    (key) => headers[key] !== undefined,
  )
}

export function loopbackAuthority(authority: string | undefined, port: string) {
  if (!authority) return false
  try {
    const url = new URL(`http://${authority}`)
    return (
      (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.hostname.endsWith('.localhost')) &&
      (url.port || '80') === port &&
      !url.username &&
      !url.password &&
      url.pathname === '/'
    )
  } catch {
    return false
  }
}
export function loopbackOrigin(origin: string, port: string) {
  try {
    const url = new URL(origin)
    return ['http:', 'https:'].includes(url.protocol) && loopbackAuthority(url.host, port)
  } catch {
    return false
  }
}
