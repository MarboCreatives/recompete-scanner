'use client'

// The backstop for anything not handled where it happened.
//
// Its sentence is deliberately different from the database outage page, so that
// seeing this one tells you the outage path was not the cause. No check asserts
// this file over HTTP, because it cannot: this Next.js version paints the error
// boundary on the client after hydration, and the HTML response carries only an
// error marker. A check asserts its contents on disk instead.
//
// The error object is never rendered or logged here. A database error carries
// the offending row value in its detail field.

export default function Error() {
  return (
    <main>
      <h1>Something went wrong</h1>
      <p>Something went wrong. Nothing is lost; try again in a few minutes.</p>
    </main>
  )
}
