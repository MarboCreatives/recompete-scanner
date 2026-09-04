// Shown once, after an account is deleted.
//
// The two caveats are here because they are true and because nobody would ever
// find them out otherwise. Saying "your data is gone" without them would be the
// easier sentence and the wrong one.

import Link from 'next/link'

export default function DeletedPage() {
  return (
    <main>
      <h1>Your account is deleted</h1>

      <p>Your account, sessions, watchlist and preferences have been removed.</p>

      <p>
        Resend keeps a copy of the sign-in emails already sent to you, including your
        address, and deletes it within 30 days. We cannot reach that copy.
      </p>

      <p>
        The database provider keeps short-term point-in-time backups that expire on their
        own schedule. We cannot reach those either.
      </p>

      <p>
        You can sign up again at any time with the same address; nothing is held against
        it.
      </p>

      <p>
        <Link href="/">Back to the start</Link>
      </p>
    </main>
  )
}
