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

/** Minimal escaping for the one value that reaches the body below. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The single response for a request that failed the same-origin check.
 *
 * It used to be the bare word `Forbidden.` and nothing else. That cost the
 * owner real time on 6 September 2026: this deployment answers on four
 * addresses, and only the one `APP_URL` names is accepted. The other three are
 * behind the hosting provider's own login, so somebody signed in there sees the
 * sign-in page render perfectly, presses the button, and gets one unexplained
 * word. It looks exactly like the site being broken, and it is the same bare
 * 403 that an unset `APP_URL` produced twice before (G17, G21).
 *
 * So the page now names the address that does work. Nothing about the check
 * itself is relaxed: this is the response to a request that was refused, and it
 * is still refused. `APP_URL` is a public value printed on every page's links,
 * so saying it here gives nothing away.
 */
export function forbidden(): Response {
  let where: string | null = null
  try {
    where = appUrl()
  } catch {
    // appUrl() throws on a production deployment with nothing configured. A
    // helper that crashed while explaining a refusal would answer 500 instead
    // of 403, which is the one thing this must not do.
    where = null
  }

  const line = where
    ? `This site only accepts forms sent from <a href="${escapeHtml(where)}">${escapeHtml(where)}</a>. ` +
      'You opened it at a different address, so nothing was submitted. Go there and try again.'
    : 'This site could not confirm where the form was sent from, so nothing was submitted.'

  const body = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Not accepted from this address</title></head><body>',
    '<main><h1>Not accepted from this address</h1>',
    `<p>${line}</p>`,
    '<p>Nothing was changed and nothing was sent.</p>',
    '</main></body></html>',
  ].join('')

  return new Response(body, {
    status: 403,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}
