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
  // Attached before connect(). A wrong password does not reject connect(); it
  // resolves and then throws asynchronously. Measured 2 September 2026.
  client.on('error', (err) => {
    throw new Error(`the test database connection failed after opening; code ${err?.code}`)
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

/** sha256 hex, matching what the application stores for a token. */
export async function sha256Hex(value) {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(value).digest('hex')
}
