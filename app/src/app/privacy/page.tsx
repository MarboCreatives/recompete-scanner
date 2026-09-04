// The privacy policy.
//
// Every claim on this page is checkable against the code. Several are asserted
// by tests, and the schema itself enforces others: there is no password column,
// no ip or user_agent column on sessions, and no deleted_at anywhere, so
// "deletion means deletion" is a property of the database rather than a promise.
//
// It has to exist before anyone can create an account, which is why it lands in
// the same change as the deletion path it describes.

import Link from 'next/link'

export const metadata = {
  title: 'Privacy — Canadian Recompete Radar',
}

export default function PrivacyPage() {
  return (
    <main>
      <h1>Privacy</h1>

      <p>
        Canadian Recompete Radar watches federal contracts and tells you when one looks
        like it may be coming up for renewal. This policy covers the signed-in
        application. The public website at recompeteradar.ca has no accounts and is not
        covered here.
      </p>

      <h2>What we store, and why</h2>

      <p>
        <strong>Your email address.</strong> It is how you sign in and where alerts will
        be sent. It is the only thing we hold that identifies you.
      </p>
      <p>
        <strong>Your watchlist.</strong> The contracts and companies you choose to
        follow, stored as reference codes rather than names.
      </p>
      <p>
        <strong>Your alert preferences.</strong> How often you want to hear from us, and
        the contract value below which you do not want to be told.
      </p>
      <p>
        <strong>Your sign-in sessions.</strong> One row for each device you are signed in
        on. Each holds a one-way fingerprint of a random value, never the value itself,
        so reading our database would not let anyone sign in as you.
      </p>
      <p>That is the whole list.</p>

      <h2>What we deliberately do not store</h2>

      <p>
        <strong>No password.</strong> There is none to store, none to leak, and none to
        reset. You sign in with a link sent to your address.
      </p>
      <p>
        <strong>No IP address, and no record of your browser or device.</strong> We
        considered keeping them and chose not to; an address tied to an email is personal
        data we have no use for.
      </p>
      <p>
        <strong>No tracking, no advertising, and no third-party analytics</strong> in the
        signed-in application.
      </p>
      <p>
        <strong>Never your address in our logs.</strong> Our logs record what happened,
        such as that a sign-in link was requested, never who it involved. This is
        enforced in code rather than by care: the only function that writes to a log
        discards any value containing an at sign, and refuses any field that is not on a
        short approved list.
      </p>

      <h2>How long we keep it</h2>

      <p>
        <strong>Sign-in links: usable for 15 minutes.</strong> The record of one is
        erased within about an hour after that, the next time anyone asks for a link. We
        keep it for that extra hour so repeated requests can be rate-limited.
      </p>
      <p>
        <strong>Sessions: 30 days.</strong> They do not extend themselves; after 30 days
        you sign in again. Signing out removes that device&rsquo;s session immediately.
      </p>
      <p>
        <strong>Your account: until you delete it.</strong>
      </p>

      <h2>Where it is stored</h2>

      <p>
        In the United States. Our database is in Northern Virginia, our application runs
        in Washington, and our email is sent by a United States company.
      </p>
      <p>
        We looked for a Canadian option and our database provider does not offer one.
        Being stored in the United States means the data can be subject to United States
        law, including lawful access requests, in ways Canadian data is not. If that is
        not acceptable to you, please do not create an account.
      </p>

      <h2>Deleting your account</h2>

      <p>
        There is a Delete account button on your{' '}
        <Link href="/account">account page</Link>. It removes your account, your
        sessions, your watchlist and your preferences. Rows are deleted, not hidden, and
        not marked inactive.
      </p>
      <p>Two things we cannot reach, stated plainly rather than left for you to find:</p>
      <p>
        Our email provider keeps a copy of the sign-in emails already sent to you,
        including your address, and deletes it within 30 days. We cannot reach that copy.
      </p>
      <p>
        Our database provider keeps short-term point-in-time backups that expire on their
        own schedule. We cannot reach those either.
      </p>

      <h2>Your rights</h2>

      <p>
        Under PIPEDA you may ask what we hold about you, ask us to correct it, and
        withdraw your consent. The fastest route to all of it is the Delete account
        button. For anything else, write to us at the address below.
      </p>

      <h2>Alerts, and your consent</h2>

      <p>
        Alert emails are commercial electronic messages under CASL. We send them only
        after you have asked for them, every one carries an unsubscribe link that works,
        and unsubscribing stops them. Alerts are not switched on in this release.
      </p>

      <h2>Who we are</h2>

      <p>
        Canadian Recompete Radar
        <br />
        PO Box 1184, Pembroke, Ontario K8A 6Y6
        <br />
        hello@recompeteradar.ca
      </p>

      <h2>Changes</h2>

      <p>
        If this policy changes in a way that affects what we store or who we share it
        with, we will say so on this page and by email before it takes effect.
      </p>

      <p>
        <Link href="/">Back to the start</Link>
      </p>
    </main>
  )
}
