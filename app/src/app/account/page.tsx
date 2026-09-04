// The account page. In Iteration 0 it holds one thing: deletion.
//
// The confirmation is a checkbox rather than a second page, because a person
// who has decided to leave should not have to fight a flow to do it. It exists
// only so the button cannot be pressed by accident.

import Link from 'next/link'
import { requireUser } from '@/lib/session'
import { DatabaseOutage } from '@/components/database-outage'

export const dynamic = 'force-dynamic'

const PROBLEMS: Record<string, string> = {
  confirm: 'Tick the box to confirm before pressing Delete account.',
  delete: 'The deletion did not complete. Try again in a few minutes.',
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ problem?: string }>
}) {
  const state = await requireUser()
  if (state.kind === 'outage') return <DatabaseOutage />

  const { problem } = await searchParams
  const message = problem ? PROBLEMS[problem] : undefined

  return (
    <main>
      <h1>Your account</h1>

      {message ? <p role="alert">{message}</p> : null}

      <p>Signed in as {state.user.email}.</p>
      <p>
        Signing in is by emailed link, so there is no password to change and none is
        stored.
      </p>

      <h2>Delete your account</h2>

      <p>
        This removes your account, your sessions, your watchlist and your preferences.
        Rows are deleted, not hidden. It cannot be undone, and we cannot restore it for
        you.
      </p>
      <p>
        Two things we cannot reach: our email provider keeps a copy of the sign-in emails
        already sent to you, including your address, and deletes it within 30 days; and
        our database provider keeps short-term backups that expire on their own schedule.
      </p>

      <form method="post" action="/account/delete">
        <label htmlFor="confirm">
          <input id="confirm" type="checkbox" name="confirm" value="yes" /> I understand
          this cannot be undone
        </label>
        <button type="submit">Delete account</button>
      </form>

      <p>
        <Link href="/privacy">What we store, in full</Link>
      </p>
      <p>
        <Link href="/feed">Back to your feed</Link>
      </p>
    </main>
  )
}
