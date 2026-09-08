// The watchlist: everything this person follows, and a way to stop.
//
// Contracts and suppliers are separate sections because they are different
// kinds of thing and are identified differently. Within each, newest first, so
// the thing just added is at the top of the section a person is looking at.
//
// No expiry date appears on this page, so the option-year caveat does not.
// That caveat explains how to read an expiry date, and printing it beside an
// "Added" date would attach a warning to the wrong number. The feed keeps it.

import Link from 'next/link'
import { requireUser } from '@/lib/session'
import { query, DatabaseError } from '@/lib/db'
import { DatabaseOutage } from '@/components/database-outage'
import { NothingWatched } from '@/components/nothing-watched'
import {
  splitContractKey,
  governmentRecordUrl,
  SUPPLIER_KEY_NOTE,
  MAX_WATCH_ITEMS,
} from '@/lib/watch'
import {
  supplierPageUrls,
  NO_SUPPLIER_PAGE_NOTE,
  SUPPLIER_LINKS_UNAVAILABLE_NOTE,
} from '@/lib/supplier-directory'

export const dynamic = 'force-dynamic'

type Row = { kind: string; target_key: string; added_on: string }

/**
 * One sentence for each way an attempt can fail. None of them is a substring
 * of another, so a check can assert that the page shows one and none of the
 * others.
 */
const PROBLEMS: Record<string, string> = {
  invalid: 'That watch request was not valid. Nothing was added.',
  full: `Your watchlist is full at ${MAX_WATCH_ITEMS} items. Remove something before adding more.`,
  add: 'That could not be saved just now. Nothing was changed. Try again in a few minutes.',
  remove: 'That could not be removed just now. Try again in a few minutes.',
}

export default async function WatchlistPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const state = await requireUser()
  if (state.kind === 'outage') return <DatabaseOutage />

  const { problem } = await searchParams
  const message = typeof problem === 'string' ? PROBLEMS[problem] : undefined

  let rows: Row[]
  try {
    // The date is formatted by the database in the timezone this product is
    // operated from, so the page renders the same day for everyone and no
    // client locale can turn 09-05 into 05-09.
    rows = await query<Row>(
      `select kind, target_key,
              to_char(created_at at time zone 'America/Toronto', 'YYYY-MM-DD') as added_on
         from watch_items
        where user_id = $1
        order by created_at desc, target_key`,
      [state.user.id],
    )
  } catch (err) {
    if (err instanceof DatabaseError) return <DatabaseOutage />
    throw err
  }

  const contracts = rows.filter((r) => r.kind === 'contract')
  const vendors = rows.filter((r) => r.kind === 'vendor')

  // Resolved once for the whole page rather than once per row, so a watchlist
  // of fifty suppliers still costs at most one request to the public site, and
  // usually none. Never throws: a supplier that cannot be resolved is rendered
  // without a link, which is also the correct answer for a supplier the site
  // deliberately publishes no page for.
  //
  // `status` matters as much as the map. "This supplier has no page" is a claim
  // about the world and must not be printed when the truth is that the site
  // could not be read, which with 200 possible rows would be that false claim
  // 200 times over. CODING-STANDARDS 4.
  const supplierPages = await supplierPageUrls(vendors.map((r) => r.target_key))
  const linksUnavailable = supplierPages.status === 'unavailable'

  return (
    <main>
      <p className="eyebrow">Watchlist</p>
      <h1>What you follow</h1>

      {message ? <p role="alert">{message}</p> : null}

      {rows.length === 0 ? <NothingWatched /> : null}

      {contracts.length > 0 ? (
        <>
          <h2>Contracts</h2>
          <ul>
            {contracts.map((r) => (
              <li key={`contract:${r.target_key}`}>
                <ContractRow k={r.target_key} addedOn={r.added_on} />
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {vendors.length > 0 ? (
        <>
          <h2>Suppliers</h2>
          <p className="sb">{SUPPLIER_KEY_NOTE}</p>
          {linksUnavailable ? <p role="alert">{SUPPLIER_LINKS_UNAVAILABLE_NOTE}</p> : null}
          <ul>
            {vendors.map((r) => (
              <li key={`vendor:${r.target_key}`}>
                <SupplierRow
                  k={r.target_key}
                  addedOn={r.added_on}
                  pageUrl={supplierPages.urls.get(r.target_key) ?? null}
                  linksUnavailable={linksUnavailable}
                />
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <p>
        <Link href="/feed">Your feed</Link>
      </p>
      <p>
        <Link href="/account">Your account</Link>
      </p>
    </main>
  )
}

function ContractRow({ k, addedOn }: { k: string; addedOn: string }) {
  const { org, reference } = splitContractKey(k)
  return (
    <>
      <p className="ref">{reference}</p>
      <p className="row-meta">
        Department {org} &middot; added {addedOn}
      </p>
      <p>
        <a href={governmentRecordUrl(k)}>Check it on the government record</a>
      </p>
      <form method="post" action="/watch/remove" className="quiet">
        <input type="hidden" name="kind" value="contract" />
        <input type="hidden" name="key" value={k} />
        <button type="submit">Stop watching</button>
      </form>
    </>
  )
}

/**
 * The name is the link, because that is the thing a person points at.
 *
 * A supplier with no page on the site keeps the plain heading it had before
 * and is told why, rather than being given a control that goes nowhere or, in
 * the earlier version of this idea, a guessed address that returns 404. Most
 * suppliers in the contract data are below the site's size threshold, and a
 * private individual has no page at all, so the unlinked row is an ordinary
 * outcome and has to read like one.
 */
function SupplierRow({
  k,
  addedOn,
  pageUrl,
  linksUnavailable,
}: {
  k: string
  addedOn: string
  pageUrl: string | null
  linksUnavailable: boolean
}) {
  return (
    <>
      <p className="row-key">
        {pageUrl === null ? k : <a href={pageUrl}>{k}</a>}
      </p>
      <p className="row-meta">Added {addedOn}</p>
      {pageUrl === null && !linksUnavailable ? (
        <p className="sb">{NO_SUPPLIER_PAGE_NOTE}</p>
      ) : null}
      <form method="post" action="/watch/remove" className="quiet">
        <input type="hidden" name="kind" value="vendor" />
        <input type="hidden" name="key" value={k} />
        <button type="submit">Stop watching</button>
      </form>
    </>
  )
}
