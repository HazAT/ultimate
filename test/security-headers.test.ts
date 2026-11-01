import { expect, it } from 'vitest'
import { securityHeaders } from '../server/main.ts'

it('sends a CSP whose every source expression a browser accepts', () => {
  // A single unparseable expression makes a browser drop the whole `frame-ancestors` directive, turning framing
  // protection off without any visible failure. `http://[::1]:*` was that expression: a CSP host source may not
  // carry a port range with an IPv6 literal.
  const csp = securityHeaders['Content-Security-Policy']
  const directive = csp.split(';').find((part) => part.trim().startsWith('frame-ancestors'))!
  for (const source of directive.replace('frame-ancestors', '').trim().split(/\s+/)) {
    const bare = source.replace(/^'.*'$/, '')
    if (bare === '') continue // a keyword such as 'self'
    expect(source, 'IPv6 literals are not valid here').not.toMatch(/\[/)
    expect(source).toMatch(/^https?:\/\/[a-z0-9.:*-]+$/)
  }
  expect(directive).toContain("'self'")
})

it('keeps the loopback port allowance a preview needs', () => {
  // `extensions/instance/web.tsx` frames another instance on its own port: same site, different origin.
  expect(securityHeaders['Content-Security-Policy']).toContain('http://127.0.0.1:*')
})

it('refuses framing to a page on another origin', () => {
  const csp = securityHeaders['Content-Security-Policy']
  expect(csp).not.toContain("*'")
  expect(csp).not.toMatch(/frame-ancestors[^;]*\s\*\s/)
})

it('sets the other response protections', () => {
  expect(securityHeaders['X-Content-Type-Options']).toBe('nosniff')
  expect(securityHeaders['Referrer-Policy']).toBe('no-referrer')
  expect(securityHeaders['X-Frame-Options']).toBe('SAMEORIGIN')
  // `Cache-Control` is applied per request instead: only the API and the HTML document skip the browser cache,
  // so Vite's modules and assets keep their own revalidation for a remote page.
  expect(Object.keys(securityHeaders)).not.toContain('Cache-Control')
})
