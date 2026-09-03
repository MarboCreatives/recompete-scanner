// Shared setup for the test suite.
//
// The suite is destructive: it deletes rows between cases. On 2 September 2026
// the three Vercel environments were compared and found to hold the identical
// connection string, same host and same database, so "development" and
// "production" were the same database. Running this suite as configured would
// have written to live data.
//
// So the connection is derived here, and guarded here. No new secret is stored;
// the test connection is the ordinary one with the database name swapped.

import { Client } from '@neondatabase/serverless'

export const TEST_DATABASE = 'recompete_test'

/**
 * Build the test connection string from DATABASE_URL_UNPOOLED by replacing only
 * the database name.
 */
export function testConnectionString() {
  const base = process.env.DATABASE_URL_UNPOOLED
  if (!base) {
    throw new Error(
      'DATABASE_URL_UNPOOLED is not set. The test suite reads no env file; put it ' +
        'in the shell. See app/db/README.md.',
    )
  }
  const url = new URL(base)
  url.pathname = `/${TEST_DATABASE}`
  return url.toString()
}

/**
 * Connect, then refuse to go any further unless the server itself says we are on
 * the test database.
 *
 * The guard asks the server rather than inspecting the string it just built.
 * Checking the string would be trusting the very thing under test, which is how
 * the main site's name-suppression audit was once fooled into passing: it called
 * the function it was supposed to be validating. `select current_database()` is
 * an independent answer from the other side of the connection.
 */
export async function connectToTestDatabase(connectionString = testConnectionString()) {
  const client = new Client({ connectionString })
  // Attached before connect(), because a wrong password does not reject
  // connect(); it resolves and the failure arrives later. Measured 2 September
  // 2026.
  //
  // The handler records rather than throws. Throwing from here would surface
  // after the test that owns the connection has finished, which Node reports as
  // an unrelated uncaught exception rather than a test failure. Neon's free
  // plan suspends an idle compute and closes the socket (57P01), so this fires
  // in normal operation and must not be fatal. A genuine credential fault is
  // still caught, by the round trip below.
  client.on('error', (err) => {
    client.recompeteLastError = err
  })
  await client.connect()

  const result = await client.query('select current_database() as db')
  const actual = result.rows[0]?.db
  if (actual !== TEST_DATABASE) {
    await client.end().catch(() => {})
    throw new Error(
      `REFUSING TO RUN. The tests are destructive and must only touch the ` +
        `"${TEST_DATABASE}" database, but the server reports "${actual}". ` +
        'Nothing was read or written. Check DATABASE_URL_UNPOOLED.',
    )
  }
  return client
}

/** Empty every table the tests write to, in foreign-key-safe order. */
export async function truncateAll(client) {
  await client.query(
    'truncate table event_deliveries, watch_items, alert_preferences, sessions, ' +
      'sign_in_tokens, events, users restart identity cascade',
  )
}


/**
 * The text a reader would see, with markup removed.
 *
 * Asserting against raw HTML is brittle: React inserts empty comment markers
 * between interpolated text nodes, so `You are about to sign in as {email}.`
 * arrives as `as <!-- -->someone@example.com<!-- -->.` and a plain substring
 * match fails on correct output. Stripping to visible text also means an
 * assertion keeps passing when markup changes but the promise does not, which
 * is the property these checks are actually about.
 */
export function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Run a test body with a database connection that is always closed.
 *
 * Written after a real failure: a test that threw skipped its `await db.end()`,
 * the Neon socket stayed open, and `node --test` waited for the event loop to
 * drain, so the whole run hung instead of reporting a failure. A suite that
 * hangs on failure is worse than one that fails, because in CI it reads as a
 * timeout rather than as the specific thing that broke.
 */
export async function withDatabase(fn) {
  const client = await connectToTestDatabase()
  try {
    await truncateAll(client)
    return await fn(client)
  } finally {
    try {
      await truncateAll(client)
    } catch {
      // Tidying failed; closing the connection still matters more.
    }
    await client.end().catch(() => {})
  }
}
