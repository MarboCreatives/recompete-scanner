// Responses that every mutation route returns.
//
// Redirects here are built by hand rather than with `redirect()` from
// next/navigation. That helper serves a 307 outside progressive-enhancement
// Server Action submissions, confirmed in the bundled documentation for this
// exact Next.js version. A 307 preserves the request method, so a browser
// following one after a form POST would POST again to the destination, which is
// wrong for every route here. 303 is the status that means "your POST worked;
// now GET this instead".
//
// Observed on 2 September 2026: a cookie set through `cookies().set()` in the
// same handler is merged onto a response built this way, so no extra step is
// needed to carry the session cookie onto the redirect.

import { NextResponse } from 'next/server'
import { appUrl } from './env'

/** A 303 to a path on this site. */
export function see(path: string): NextResponse {
  return NextResponse.redirect(new URL(path, `${appUrl()}/`), 303)
}

/** The single response for a request that failed the same-origin check. */
export function forbidden(): Response {
  return new Response('Forbidden.', {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}
