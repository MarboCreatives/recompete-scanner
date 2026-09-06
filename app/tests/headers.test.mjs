// The response headers every path must carry, asserted over HTTP.
//
// Why over HTTP and not by reading next.config.ts: the file can say anything.
// On 5 September 2026 the live deployment was measured sending no
// Referrer-Policy at all, while a comment in src/lib/same-origin.ts stated that
// one was sent on every response. Only the wire can settle that.
//
// Referrer-Policy matters here because the sign-in confirmation page's address
// carries the token, and because the watchlist links out to other sites. A
// browser following such a link without this header would send the referring
// address, token included, to the destination.
//
// Requires BASE_URL and a running server, like the other flow checks.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'

/** Paths of every kind the app answers with: a page, a redirect, a 404, and a route handler. */
const CASES = [
  { path: '/', method: 'GET', expect: 200, what: 'a public page' },
  { path: '/privacy', method: 'GET', expect: 200, what: 'a statically rendered page' },
  { path: '/feed', method: 'GET', expect: [302, 303, 307], what: 'a redirect from a server component' },
  { path: '/no-such-page', method: 'GET', expect: 404, what: 'the not-found page' },
  { path: '/auth/sign-out', method: 'POST', expect: 403, what: 'a hand-built response from a route handler' },
]

for (const c of CASES) {
  test(`${c.what} (${c.method} ${c.path}) carries the security headers`, async () => {
    const r = await fetch(`${BASE}${c.path}`, { method: c.method, redirect: 'manual' })
    const expected = Array.isArray(c.expect) ? c.expect : [c.expect]
    assert.ok(expected.includes(r.status), `expected ${expected.join('/')} got ${r.status}`)

    assert.equal(
      r.headers.get('referrer-policy'),
      'no-referrer',
      'Referrer-Policy: no-referrer must be present; a token in a URL would otherwise leak to any site we link to',
    )
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(r.headers.get('x-powered-by'), null, 'the framework header must be switched off')
  })
}
