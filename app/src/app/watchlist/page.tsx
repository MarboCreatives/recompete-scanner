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

  return (
    <main>
      <h1>Your watchlist</h1>

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
          <p>{SUPPLIER_KEY_NOTE}</p>
          <ul>
            {vendors.map((r) => (
              <li key={`vendor:${r.target_key}`}>
                <SupplierRow k={r.target_key} addedOn={r.added_on} />
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
      <span>
        {reference} ({org})
      </span>{' '}
      <a href={governmentRecordUrl(k)}>Government record</a>{' '}
      <span>Added {addedOn}</span>
      <form method="post" action="/watch/remove">
        <input type="hidden" name="kind" value="contract" />
        <input type="hidden" name="key" value={k} />
        <button type="submit">Stop watching</button>
      </form>
    </>
  )
}

function SupplierRow({ k, addedOn }: { k: string; addedOn: string }) {
  return (
    <>
      <span>{k}</span> <span>Added {addedOn}</span>
      <form method="post" action="/watch/remove">
        <input type="hidden" name="kind" value="vendor" />
        <input type="hidden" name="key" value={k} />
        <button type="submit">Stop watching</button>
      </form>
    </>
  )
}
