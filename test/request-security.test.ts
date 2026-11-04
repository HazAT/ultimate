import { expect, it } from 'vitest'
import { admit, deviceOf, loopbackAuthority, loopbackOrigin } from '../server/request-security.ts'

it.each(['127.0.0.1', 'localhost', '[::1]', 'ultimate.localhost', 'preview.ultimate.localhost'])(
  'admits direct loopback host and origin %s on the listening port',
  async (host) => {
    expect(loopbackAuthority(`${host}:4799`, '4799')).toBe(true)
    expect(loopbackOrigin(`http://${host}:4799`, '4799')).toBe(true)
    expect(
      await admit(
        { headers: { host: `${host}:4799`, origin: `http://${host}:4799` } },
        '4799',
        new Set(),
      ),
    ).toBe(true)
  },
)

it.each([
  'evil.com:4799',
  'localhost.evil.com:4799',
  'ultimatelocalhost:4799',
  'ultimate.localhost:4800',
])('rejects foreign or wrong-port authority %s and its origin', async (host) => {
  expect(loopbackAuthority(host, '4799')).toBe(false)
  expect(loopbackOrigin(`http://${host}`, '4799')).toBe(false)
  expect(await admit({ headers: { host } }, '4799', new Set())).toBe(false)
  expect(
    await admit(
      { headers: { host: 'ultimate.localhost:4799', origin: `http://${host}` } },
      '4799',
      new Set(),
    ),
  ).toBe(false)
})

it('does not admit forwarded localhost subdomains', async () => {
  expect(
    await admit(
      { headers: { host: 'ultimate.localhost:4799', 'x-forwarded-for': '127.0.0.1' } },
      '4799',
      new Set(),
    ),
  ).toBe(false)
})

it('labels a request by its browser, with the Tailscale login only behind Serve', () => {
  const iphone =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
  const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36'
  expect(deviceOf({ 'user-agent': iphone })).toEqual({ device: 'phone safari' })
  expect(
    deviceOf({
      'user-agent': linux,
      'tailscale-user-login': 'me@example.com',
      'x-forwarded-for': '100.64.0.2',
    }),
  ).toEqual({ device: 'desktop chrome', login: 'me@example.com', address: '100.64.0.2' })
  // A login header that no proxy set is a local client's claim, not Tailscale's.
  expect(deviceOf({ 'user-agent': linux, 'tailscale-user-login': 'me@example.com' })).toEqual({
    device: 'desktop chrome',
  })
  expect(deviceOf({})).toEqual({ device: 'desktop other' })
})

it('keeps only the tailnet address Serve forwarded', () => {
  const address = (forwarded: string) =>
    deviceOf({ 'x-forwarded-for': forwarded, 'tailscale-user-login': 'me@example.com' }).address
  // Without Serve's login the header is anyone's claim.
  expect(deviceOf({ 'x-forwarded-for': '100.64.0.2' })).toEqual({ device: 'desktop other' })
  expect(address('fd7a:115c:a1e0::1')).toBe('fd7a:115c:a1e0::1')
  // Should a proxy append, only the rightmost entry counts; a leftmost one is the client's own claim.
  expect(address('100.64.0.9, 100.100.1.2')).toBe('100.100.1.2')
  expect(address('100.64.0.9, 192.168.1.5')).toBeUndefined()
  for (const outside of ['127.0.0.1', '192.168.1.5', '100.128.0.1', '::1', 'not-an-ip', ''])
    expect(address(outside)).toBeUndefined()
})
