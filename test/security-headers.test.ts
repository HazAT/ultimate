import { expect, it } from 'vitest'
import { securityHeaders } from '../server/main.ts'

it('sends a frame-ancestors whose every source expression a browser accepts', () => {
  // A single unparseable expression makes a browser drop the whole `frame-ancestors` directive, turning framing
  // protection off without any visible failure. `http://[::1]:*` was that expression: a CSP host source may not
  // carry a port range with an IPv6 literal.
  const directive = securityHeaders['Content-Security-Policy']
    .split(';')
    .find((part) => part.trim().startsWith('frame-ancestors'))!
  for (const source of directive.trim().split(/\s+/).slice(1))
    expect(source).toMatch(/^'self'$|^http:\/\/(\*\.)?[a-z0-9.]+:\*$/)
})
