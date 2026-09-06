// GET /sign-in/verify?token=... — what the emailed link opens.
//
// This page never writes. Following the link does not sign anyone in; pressing
// the button on it does. That is deliberate: mail scanners and link previewers
// fetch URLs found in email, and if opening the link were enough, a scanner
// would spend the token before the person ever saw the page.

import Link from 'next/link'
import { isTokenShaped } from '@/lib/tokens'
import { queryOne, DatabaseError } from '@/lib/db'
import { DatabaseOutage } from '@/components/database-outage'

export const dynamic = 'force-dynamic'

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams

  if (!isTokenShaped(token)) {
    return (
      <main>
        <h1>Sign in</h1>
        <p>This link is not valid.</p>
        <p>
          <Link href="/sign-in">Ask for a new link</Link>
        </p>
      </main>
    )
  }

  // Read only. The token is spent by the form below, not by this page.
  const { hashToken } = await import('@/lib/tokens')

  // The outage is caught here rather than allowed to throw, for the same
  // reason the feed, the account page and the watch page catch it: a Server
  // Component that throws in this framework version returns a body carrying
  // only an error marker, and the boundary's text is painted on the client
  // after hydration, so the reader gets a page with no words on it at all.
  // This page is the worst place for that: it is the one screen on the sign-in
  // path, and somebody who sees nothing will ask for more links and spend
  // their five-an-hour allowance on a fault that has nothing to do with them.
  let row: { email: string } | undefined
  try {
    row = await queryOne<{ email: string }>(
      'select email from sign_in_tokens where token_hash = $1 and expires_at > now()',
      [hashToken(token)],
    )
  } catch (err) {
    if (err instanceof DatabaseError) return <DatabaseOutage />
    throw err
  }

  if (!row) {
    // The same sentence the sign-in page shows for ?problem=expired, on purpose:
    // it means the same thing in both places. Expired, already used and never
    // existed are not told apart, because distinguishing them would say whether
    // a link had ever been issued.
    return (
      <main>
        <h1>Sign in</h1>
        <p>This link has expired or was already used. Request a new one.</p>
        <p>
          <Link href="/sign-in">Ask for a new link</Link>
        </p>
      </main>
    )
  }

  return (
    <main>
      <h1>Confirm sign in</h1>
      <p>You are about to sign in as {row.email}.</p>
      <p>Only continue if you asked for this link.</p>
      <form method="post" action="/auth/confirm">
        <input type="hidden" name="token" value={token} />
        <button type="submit">Confirm sign in</button>
      </form>
    </main>
  )
}
