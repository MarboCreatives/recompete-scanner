// Reached only after a send actually succeeded, so the sentence below is true
// wherever it is rendered. Every failure path goes to /sign-in with its own
// message instead; none of them lands here.
//
// It names the subject line and says to look in spam. That is not padding: this
// is the one moment the person has to leave the product and go hunting in a
// mail client, and a first message from an unfamiliar sender is exactly what a
// spam filter holds back. Telling them what to search for costs one sentence
// and saves the whole sign-in.
//
// "Ask for another link" is deliberately not the first thing offered. Pressing
// it burns another of the five links an address may have in an hour, and the
// usual reason someone presses it is that the first one has not arrived yet.

import Link from 'next/link'
import { SIGN_IN_SUBJECT } from '@/lib/email-templates'

export default function SignInSentPage() {
  return (
    <main>
      <h1>Check your email</h1>
      <p>
        If that address can receive email, a sign-in link is on its way. It works once
        and expires in 15 minutes.
      </p>
      <p className="sb">
        It comes from Canadian Recompete Radar, and the subject is
        &ldquo;{SIGN_IN_SUBJECT}&rdquo;. If it is not in your inbox within a minute or
        two, look in your spam or promotions folder.
      </p>
      <p className="sb">
        Still nothing? Wait a couple of minutes before asking again — each request uses
        one of the five links an address may have in an hour.
      </p>
      <p>
        <Link href="/sign-in">Ask for another link</Link>
      </p>
    </main>
  )
}
