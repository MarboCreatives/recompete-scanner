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
// **Why not `same-origin` either, which is what the emergency fix shipped.**
// `same-origin` withholds the Referer from other sites but sends the FULL URL,
// path and query included, on same-origin requests. The sign-in confirmation
// page carries the token in its query string, so the live token then rides in
// the Referer on every same-origin request that page makes, including the POST
// that spends it and every static asset it pulls. Measured in a real browser
// on 6 September 2026: after confirming, `document.referrer` on /feed was
// `http://127.0.0.1:3123/sign-in/verify?token=<the live 43-character token>`.
// The watch pages carry a supplier key in the same way, and MASTER-DESIGN rule
// 8 says a watchlist never appears in a log.
//
// `strict-origin` sends the origin and nothing else, to anyone: no path, no
// query, no token, no watch key. It withholds even that on an HTTPS to HTTP
// downgrade. And in the Fetch standard's Origin step it falls to the
// "otherwise, do nothing" branch, so the Origin header arrives intact and G28
// cannot recur. Measured the same way: the form works and
// `document.referrer` carries no token.
//
// The check suite did not catch this, because every check sends its own
// `Origin` header explicitly, the way `fetch` and `curl` do. Only a browser
// navigating a real form reproduces it. tests/headers.test.mjs now asserts the
// policy by name and says why.
const SECURITY_HEADERS = [
  { key: 'Referrer-Policy', value: 'strict-origin' },
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
