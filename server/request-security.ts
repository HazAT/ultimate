import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import { BlockList, isIP } from 'node:net'
import type { Device } from '../shared/events.ts'

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
  const navigation =
    (site === 'cross-site' || site === 'same-site') &&
    request.method === 'GET' &&
    (request.url === '/' || request.url?.startsWith('/?') === true) &&
    request.headers['sec-fetch-mode'] === 'navigate' &&
    request.headers['sec-fetch-dest'] === 'document' &&
    request.headers.upgrade === undefined
  // Root navigation relaxes only fetch metadata, not origin or identity verification.
  // Any site can now open the UI with any query, so query parameters must only select views, never act.
  if (site !== undefined && site !== 'same-origin' && site !== 'none' && !navigation) return false
  for (const rule of rules) {
    if (host !== new URL(rule.origin).host || (origin && origin !== rule.origin)) continue
    try {
      if ((await rule.verify(request))?.login && rules.has(rule)) return true
    } catch {
      // A failed identity provider cannot admit a request.
    }
  }
  return false
}

/** Tailscale's address ranges: the CGNAT block it assigns IPv4 addresses from and its IPv6 ULA prefix. */
const tailnet = new BlockList()
tailnet.addSubnet('100.64.0.0', 10, 'ipv4')
tailnet.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6')

/**
 * The short label of the browser behind a request, `phone safari` or `desktop chrome`, and the Tailscale login and
 * tailnet address of the client when Tailscale Serve proxied it. Nothing else of the request.
 */
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
  const address = tailnetAddress(headers['x-forwarded-for'])
  return { device: `${kind} ${browser}`, login, ...(address ? { address } : {}) }
}

/**
 * The client's tailnet address from `X-Forwarded-For`, read only next to Serve's login header. Serve is the single hop
 * in front of the server and sets the header to the peer address it saw, dropping what the client sent; should a
 * proxy ever append instead, the rightmost entry is still the one the last hop vouches for and anything left of it is
 * the client's claim, so only the rightmost entry counts, and only inside Tailscale's ranges.
 */
function tailnetAddress(header: string | string[] | undefined) {
  const address = [header ?? []].flat().join(',').split(',').at(-1)?.trim() ?? ''
  const family = isIP(address)
  if (!family) return undefined
  return tailnet.check(address, family === 4 ? 'ipv4' : 'ipv6') ? address : undefined
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
