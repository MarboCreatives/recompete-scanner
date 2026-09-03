import Link from 'next/link'

export default function HomePage() {
  return (
    <main>
      <h1>Canadian Recompete Radar</h1>

      <p>
        Recompete Radar watches federal contracts and tells you when one looks like it is
        coming up for renewal.
      </p>

      <p>Nothing here is a tender board, and nothing here is advice.</p>

      <p>Sign in with an emailed link; there is no password.</p>

      <p>
        <Link href="/sign-in">Sign in</Link>
      </p>

      <p>
        <Link href="/privacy">What we store, and how to delete it</Link>
      </p>

      <p>
        The public contract data lives at{' '}
        <a href="https://recompeteradar.ca">recompeteradar.ca</a>.
      </p>
    </main>
  )
}
