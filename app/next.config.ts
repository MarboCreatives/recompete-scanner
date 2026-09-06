import type { NextConfig } from 'next'

// Response headers sent with every path.
//
// Referrer-Policy: no-referrer is load-bearing, not decoration. The address of
// the sign-in confirmation page carries the token in its query string, and the
// watchlist links out to other sites. Without this header a browser following
// one of those links would hand the referring URL, token included, to whoever
// runs the destination. src/lib/same-origin.ts also relies on it: because no
// Referer is ever sent, that file has no Referer fallback, and says so.
//
// Measured 5 September 2026 against the live deployment: this header was not
// being sent at all, although the comment in same-origin.ts said it was. A
// comment is not a header. tests/headers.test.mjs now asserts it over HTTP.
const SECURITY_HEADERS = [
  { key: 'Referrer-Policy', value: 'no-referrer' },
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
