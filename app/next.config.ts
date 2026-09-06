import type { NextConfig } from 'next'

// Response headers sent with every path.
//
// ## Referrer-Policy is `same-origin`, and must never be `no-referrer`
//
// This policy is load-bearing in two opposite directions, and getting it wrong
// took the live site down on 6 September 2026.
//
// **Why a policy at all.** The sign-in confirmation page carries the token in
// its query string, and the watchlist links out to other sites. With no policy
// a browser following one of those links hands the referring address, token
// included, to whoever runs the destination. `same-origin` sends no Referer to
// another site at all, which closes that completely. src/lib/same-origin.ts
// relies on this: it has no Referer fallback, and says so.
//
// **Why not `no-referrer`, which looks stricter and is what shipped first.**
// The Fetch standard makes a browser send `Origin: null` on a non-CORS POST
// when the referrer policy is `no-referrer`. Every form on this site is a
// non-CORS POST. `isSameOrigin()` parses that value, `new URL('null')` throws,
// and the request is refused, so **every form answers 403**: sign in, sign
// out, delete account, watch, unwatch. The site looks entirely broken and
// nothing appears in any log.
//
// Measured rather than reasoned about. Same build, same machine, one header
// changed, a real browser submitting the real form:
//
//     Referrer-Policy: no-referrer   ->  "Forbidden."
//     Referrer-Policy: same-origin   ->  "Check your email"
//
// `same-origin` sets `Origin: null` only when the request is already
// cross-origin, which this site refuses anyway, so the defence is unchanged.
//
// The check suite did not catch this, because every check sends its own
// `Origin` header explicitly, the way `fetch` and `curl` do. Only a browser
// navigating a real form reproduces it. tests/headers.test.mjs now asserts the
// policy by name and says why.
const SECURITY_HEADERS = [
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
]

const nextConfig: NextConfig = {
  // Nothing about the framework version needs announcing on every response.
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }]
  },
}

export default nextConfig
