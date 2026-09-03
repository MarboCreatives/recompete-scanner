import Link from 'next/link'

export default function NotFound() {
  return (
    <main>
      <h1>Not found</h1>
      <p>That page does not exist.</p>
      <p>
        <Link href="/">Go to the start</Link>
      </p>
    </main>
  )
}
