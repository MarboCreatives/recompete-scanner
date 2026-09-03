// Shown when a page could not reach the database.
//
// This is a real page rendered with status 200, not the error boundary. Two
// independent checks against this exact Next.js version observed that a Server
// Component throwing produces a response body containing only an error marker;
// the error boundary's text is painted on the client after hydration and never
// appears in the HTML. So a person with a slow connection, or anything that
// reads the response rather than running it, would see nothing at all.
//
// Saying "we could not look" rather than rendering an empty list matters more
// here than usual. An empty feed would state, wrongly, that there is nothing to
// find.

export function DatabaseOutage() {
  return (
    <main>
      <h1>Not available just now</h1>
      <p>We could not reach the database. Nothing is lost; try again in a few minutes.</p>
    </main>
  )
}
