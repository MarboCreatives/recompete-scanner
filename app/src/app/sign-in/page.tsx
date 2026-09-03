// The sign-in page, and the one place every "something went wrong" sentence for
// this flow is written.
//
// Each sentence below is a promise to the reader, so each is written once, and
// no one of them is a substring of another. A check asserts that requesting a
// given problem shows its own sentence and none of the others.

import Link from 'next/link'

export const dynamic = 'force-dynamic'

const PROBLEMS: Record<string, string> = {
  address: 'That address does not look like an email address. Check it and try again.',
  email:
    'We could not send a sign-in link to that address just now. Try again in a few minutes.',
  expired: 'This link has expired or was already used. Request a new one.',
  unavailable:
    'We could not finish signing you in just now. Ask for a new link and try again in a few minutes.',
  unreachable:
    'We could not reach the database just now. Nothing was sent and nothing was changed. Try again in a few minutes.',
  'too-many':
    'Too many sign-in links have been asked for from this address in the last hour. Try again in an hour.',
  busy: 'Too many sign-in links have been asked for just now. Try again in an hour.',
  signout:
    'You are signed out on this device. We could not reach the database to remove the stored session, so sign out again in a few minutes.',
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ problem?: string }>
}) {
  const { problem } = await searchParams
  const message = problem ? PROBLEMS[problem] : undefined

  return (
    <main>
      <h1>Sign in</h1>

      {message ? <p role="alert">{message}</p> : null}

      <p>
        Enter your email address and we will send you a link. There is no password to
        remember and none is stored.
      </p>

      <form method="post" action="/auth/request">
        <label htmlFor="email">Email address</label>
        <input
          id="email"
          type="email"
          name="email"
          autoComplete="email"
          required
          inputMode="email"
        />
        <button type="submit">Send me a link</button>
      </form>

      <p>
        <Link href="/privacy">What we store, and how to delete it</Link>
      </p>
    </main>
  )
}
