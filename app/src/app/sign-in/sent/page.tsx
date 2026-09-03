// Reached only after a send actually succeeded, so the sentence below is true
// wherever it is rendered. Every failure path goes to /sign-in with its own
// message instead; none of them lands here.

import Link from 'next/link'

export default function SignInSentPage() {
  return (
    <main>
      <h1>Check your email</h1>
      <p>
        If that address can receive email, a sign-in link is on its way. It works once
        and expires in 15 minutes.
      </p>
      <p>
        <Link href="/sign-in">Ask for another link</Link>
      </p>
    </main>
  )
}
