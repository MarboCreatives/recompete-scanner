// The feed. Empty in Iteration 0; the scanner fills it from Iteration 2.
//
// The empty state says what happens next rather than pretending to be a result.

import Link from 'next/link'
import { requireUser } from '@/lib/session'
import { DatabaseOutage } from '@/components/database-outage'

export const dynamic = 'force-dynamic'

export default async function FeedPage() {
  const state = await requireUser()
  if (state.kind === 'outage') return <DatabaseOutage />

  return (
    <main>
      <h1>Your feed</h1>
      <p>Signed in as {state.user.email}.</p>

      <p>Following contracts and vendors arrives in the next release.</p>

      <p>
        Expiry dates show the period a department has committed to. Many contracts carry
        option years that are not published until they are exercised, so treat a date here
        as the earliest a contract could come back, not a guarantee that it will.
      </p>

      <form method="post" action="/auth/sign-out">
        <button type="submit">Sign out</button>
      </form>

      <p>
        <Link href="/account">Your account</Link>
      </p>
    </main>
  )
}
