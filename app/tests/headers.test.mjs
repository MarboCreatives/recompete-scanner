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

/** Why each of these is wrong here, so a future change knows what it is undoing. */
const bannedBecause = {
  'no-referrer': 'makes browsers send Origin: null on a form post, so every mutation answers 403 (G28)',
  'same-origin': 'sends the whole URL on same-origin requests, so the sign-in token rides in the Referer',
  'unsafe-url': 'sends the whole URL to every site, token included',
  'no-referrer-when-downgrade': 'sends the whole URL to any other https site, token included',
}

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

    // The value matters as much as the presence of the header, and it is the
    // value that took the live site down. Under `no-referrer` the Fetch
    // standard makes a browser send `Origin: null` on a non-CORS POST, which
    // is every form here; isSameOrigin() refuses that, so every form answers
    // 403. Under `same-origin` no Referer reaches another site, which is the
    // protection wanted, and the Origin header still arrives intact.
    //
    // No check here can reproduce that: they all send their own Origin header,
    // the way fetch and curl do. Only a browser navigating a real form does.
    // So the value is asserted by name, and no-referrer is ruled out
    // explicitly rather than by implication.
    const policy = r.headers.get('referrer-policy')
    assert.equal(
      policy,
      'strict-origin',
      'Referrer-Policy must be strict-origin: same-origin would send the whole URL, token and all, on same-origin requests, and no-referrer would make browsers send Origin: null and refuse every form',
    )
    for (const banned of ['no-referrer', 'same-origin', 'unsafe-url', 'no-referrer-when-downgrade']) {
      assert.notEqual(policy, banned, bannedBecause[banned])
    }
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(r.headers.get('x-powered-by'), null, 'the framework header must be switched off')
  })
}
