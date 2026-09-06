// GET /watch?kind=contract|vendor&key=... — the page a Watch link on
// recompeteradar.ca opens.
//
// It writes nothing. Watching happens when the person presses the button,
// which POSTs to /watch/add. A link that acted on being opened would be spent
// by any mail scanner, link previewer or browser prefetch that followed it,
// which is the same reason the sign-in link does not sign anyone in.
//
// The link is validated BEFORE the session is required. Sending a signed-out
// person through sign-in only to tell them the link was malformed would waste
// their time on a page that could have said so at once.

import Link from 'next/link'
import { requireUser } from '@/lib/session'
import { queryOne } from '@/lib/db'
import { DatabaseOutage } from '@/components/database-outage'
import {
  parseWatchTarget,
  splitContractKey,
  governmentRecordUrl,
  WATCH_EXPLAINER,
  SUPPLIER_KEY_NOTE,
} from '@/lib/watch'

export const dynamic = 'force-dynamic'

export default async function WatchPage({
  searchParams,
}: {
  // Deliberately the framework's own type rather than a narrower one. A
  // repeated parameter arrives as an array, and a page typed to promise
  // strings hides that from the compiler while the value is still an array at
  // run time. parseWatchTarget refuses anything that is not a string.
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const target = parseWatchTarget(params.kind, params.key)

  if (target === null) {
    return (
      <main>
        <h1>Watch</h1>
        <p>That watch link is not valid.</p>
        <p>
          <a href="https://recompeteradar.ca">Go to recompeteradar.ca</a>
        </p>
      </main>
    )
  }

  const state = await requireUser()
  if (state.kind === 'outage') return <DatabaseOutage />

  let already: boolean
  try {
    const row = await queryOne<{ id: string }>(
      'select id from watch_items where user_id = $1 and kind = $2 and target_key = $3',
      [state.user.id, target.kind, target.key],
    )
    already = row !== undefined
  } catch {
    // The two failure shapes are told apart deliberately. This one could not
    // read, so it must not claim the item is or is not already watched.
    return <DatabaseOutage />
  }

  const isContract = target.kind === 'contract'
  const heading = isContract ? 'Watch this contract?' : 'Watch this supplier?'

  return (
    <main>
      <h1>{heading}</h1>

      {isContract ? <ContractDetail k={target.key} /> : <SupplierDetail k={target.key} />}

      {already ? (
        <>
          <p>You are already watching this.</p>
          <form method="post" action="/watch/remove">
            <input type="hidden" name="kind" value={target.kind} />
            <input type="hidden" name="key" value={target.key} />
            <button type="submit">Stop watching</button>
          </form>
        </>
      ) : (
        <>
          <p>{WATCH_EXPLAINER}</p>
          <form method="post" action="/watch/add">
            <input type="hidden" name="kind" value={target.kind} />
            <input type="hidden" name="key" value={target.key} />
            <button type="submit">Watch</button>
          </form>
        </>
      )}

      <p>
        <Link href="/watchlist">Your watchlist</Link>
      </p>
    </main>
  )
}

/**
 * A contract, named by the two things that identify it in the public record.
 *
 * The department code is labelled rather than printed bare. The public site
 * shows a department by its full name and never shows this code, so a person
 * arriving here would otherwise meet a string they have never seen. The link
 * to the government's own record is the way to be certain which contract this
 * is, so it is a sentence of its own rather than a footnote.
 */
function ContractDetail({ k }: { k: string }) {
  const { org, reference } = splitContractKey(k)
  return (
    <>
      <p>Reference number {reference}.</p>
      <p>Department code {org}, as used by open.canada.ca.</p>
      <p>
        <a href={governmentRecordUrl(k)}>Check this contract on the government record</a>
      </p>
    </>
  )
}

/** A supplier, named by the identity the published data groups it under. */
function SupplierDetail({ k }: { k: string }) {
  return (
    <>
      <p>Supplier {k}.</p>
      <p>{SUPPLIER_KEY_NOTE}</p>
    </>
  )
}
