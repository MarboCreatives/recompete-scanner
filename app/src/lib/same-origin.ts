// Cross-site request forgery defence for every mutation.
//
// Two layers. The session cookie is SameSite=lax, so a browser will not send it
// on a cross-site POST at all. On top of that, every mutation route calls this
// before touching the database.
//
// There is deliberately no Referer fallback. This application sends
// `Referrer-Policy: no-referrer` on every response, so no browser ever sends a
// Referer header back to it, not even same-origin. Code that could never run,
// described in comments as a second layer, is worse than no code at all: the
// next person to read it believes there is a fallback when there is none.

import { appUrl } from './env'

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
    return new URL(sent).origin === new URL(appUrl()).origin
  } catch {
    // The Origin header is text supplied by whoever made the request, and
    // `new URL` throws on malformed input. A throw here would be a 500 where a
    // 403 is wanted.
    return false
  }
}
