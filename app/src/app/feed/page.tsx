// The feed. Still empty of events in Iteration 1; the scanner fills it from
// Iteration 2.
//
// What changed at M1 is that the page now says what this person is actually
// following, so an empty feed reads as "nothing has happened yet" rather than
// "this product does nothing". When the watchlist is empty it says so and says
// how to start, which is the empty state M1 asks for.
//
// Neither sentence claims a date for change detection. "In the next release"
// is a promise a tester will hold the product to, and nobody can keep it.

import Link from 'next/link'
import { requireUser } from '@/lib/session'
import { query, DatabaseError } from '@/lib/db'
import { DatabaseOutage } from '@/components/database-outage'
import { NothingWatched } from '@/components/nothing-watched'
import { watchingSentence } from '@/lib/watch'

export const dynamic = 'force-dynamic'

export default async function FeedPage() {
  const state = await requireUser()
  if (state.kind === 'outage') return <DatabaseOutage />

  let contracts = 0
  let vendors = 0
  try {
    const rows = await query<{ kind: string; n: number }>(
      'select kind, count(*)::int as n from watch_items where user_id = $1 group by kind',
      [state.user.id],
    )
    for (const row of rows) {
      if (row.kind === 'contract') contracts = row.n
      if (row.kind === 'vendor') vendors = row.n
    }
  } catch (err) {
    if (err instanceof DatabaseError) return <DatabaseOutage />
    throw err
  }

  const watching = contracts + vendors

  return (
    <main>
      <p className="eyebrow">Your feed</p>
      <h1>What you are following</h1>
      <p className="sb">Signed in as {state.user.email}.</p>

      {watching === 0 ? (
        <NothingWatched />
      ) : (
        <>
          {/*
            The site's own stat cards. The sentence is kept underneath rather
            than replaced: the cards are read at a glance and the sentence is
            what a screen reader and a person scanning for plain words get.
          */}
          <div className="cd">
            <div className="c">
              <div className="v">{contracts}</div>
              <div className="l">{contracts === 1 ? 'Contract' : 'Contracts'}</div>
            </div>
            <div className="c">
              <div className="v">{vendors}</div>
              <div className="l">{vendors === 1 ? 'Supplier' : 'Suppliers'}</div>
            </div>
          </div>
          <p className="sb">{watchingSentence(contracts, vendors)}</p>
          <p>
            Nothing has changed on them yet. Change detection is not switched on in this
            release.
          </p>
        </>
      )}

      <div className="notes">
        <p className="sb">
          Expiry dates show the period a department has committed to. Many contracts carry
          option years that are not published until they are exercised, so treat a date
          here as the earliest a contract could come back, not a guarantee that it will.
        </p>
      </div>

      <p>
        <Link href="/watchlist">Your watchlist</Link>
      </p>

      <form method="post" action="/auth/sign-out" className="quiet">
        <button type="submit">Sign out</button>
      </form>

      <p>
        <Link href="/account">Your account</Link>
      </p>
    </main>
  )
}
