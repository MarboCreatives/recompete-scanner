// Cross-site request forgery defence for every mutation.
//
// Two layers. The session cookie is SameSite=lax, so a browser will not send it
// on a cross-site POST at all. On top of that, every mutation route calls this
// before touching the database.
//
// There is deliberately no Referer fallback, and the reason has changed twice,
// so it is written out properly here.
//
// It used to be that this application sent `Referrer-Policy: no-referrer`, so
// no browser ever sent it a Referer at all. That header turned out to break
// every form on the site, because it also makes a browser send `Origin: null`
// on a non-CORS POST; see the note in next.config.ts and GROUND-TRUTH G28. The
// policy is now `strict-origin`, which means a Referer IS sent, carrying the
// origin and nothing else: no path, no query, no token.
//
// So a Referer fallback is still not worth having. It would carry exactly the
// same information as the Origin header already checked above, and it would be
// a second code path deciding the same question. Code that adds no information,
// described in comments as a second layer, is worse than no code at all.

import { appUrl, isLocalDevelopment } from './env'

/**
 * True when the request carries an Origin header matching this deployment.
 *
 * The comparison is between parsed origins, never raw strings. A string
 * comparison would refuse every POST on a deployment whose APP_URL was written
 * with a trailing slash, and nobody could sign in; `new URL(...).origin`
 * normalises that away.
 */
export function isSameOrigin(request: Request): boolean {
  const sent = request.headers.get('origin')
  if (sent === null) return false
  try {
    const from = new URL(sent).origin
    const mine = new URL(appUrl()).origin
    if (from === mine) return true
    return isLoopbackPairOnADeveloperMachine(from, mine)
  } catch {
    // The Origin header is text supplied by whoever made the request, and
    // `new URL` throws on malformed input. A throw here would be a 500 where a
    // 403 is wanted. This is also the branch that fires on `Origin: null`,
    // which a browser sends when the referrer policy is `no-referrer`; see the
    // long note in next.config.ts.
    return false
  }
}

/** The names a machine calls itself. Same computer, three spellings. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * True when both origins are the same local port under different names for
 * this machine, and this is a developer's own machine rather than a deployment.
 *
 * This exists because of a measured trap. `appUrl()` answers
 * `http://127.0.0.1:<port>` locally, while `next dev` prints and the README
 * gives `http://localhost:<port>`. An origin compares host as written, so
 * those two never match: pages render, and then every button answers a bare
 * `Forbidden.` with nothing in any log. Observed in a real browser on
 * 6 September 2026, and it is the fourth distinct cause of a bare 403 here
 * after G17, G21 and G28.
 *
 * It matters more than developer comfort. Driving a real form in a real
 * browser locally is the one method that catches the G28 class of fault, and
 * this trap breaks that method.
 *
 * The guard is the platform's own variable rather than anything about the
 * request: VERCEL is set on every deployment, production and preview alike, so
 * this can never widen what a deployed site accepts. On a deployment the
 * comparison above is the only one that runs.
 */
function isLoopbackPairOnADeveloperMachine(from: string, mine: string): boolean {
  if (!isLocalDevelopment()) return false
  const a = new URL(from)
  const b = new URL(mine)
  if (a.protocol !== 'http:' || b.protocol !== 'http:') return false
  if (a.port !== b.port) return false
  return LOOPBACK_HOSTS.has(a.hostname) && LOOPBACK_HOSTS.has(b.hostname)
}
