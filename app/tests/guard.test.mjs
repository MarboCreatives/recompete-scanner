// Proves the guard that keeps this destructive suite off the live database.
//
// A safety catch nobody has watched engage is not known to work, so the first
// case here points the harness at the real database and requires it to refuse.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectToTestDatabase, testConnectionString, TEST_DATABASE } from './helpers.mjs'

test('the guard refuses the production database, and reads nothing from it', async () => {
  // Build a connection string aimed squarely at the real database.
  const live = new URL(testConnectionString())
  live.pathname = '/neondb'

  await assert.rejects(
    () => connectToTestDatabase(live.toString()),
    (err) => {
      assert.match(err.message, /REFUSING TO RUN/)
      assert.match(err.message, /neondb/)
      assert.match(err.message, /Nothing was read or written/)
      return true
    },
    'pointing the harness at neondb must throw, not proceed',
  )
})

test('the guard is not fooled by a string that merely mentions the test database', async () => {
  // This is the case that separates asking the server from reading the string.
  // The connection points at the live database, but the text of it contains
  // "recompete_test", so any guard that greps its own input passes and lets the
  // destructive suite loose on production. Only asking the far end catches it.
  //
  // It is not a contrived input: application_name is an ordinary connection
  // parameter, and naming it after the suite is the obvious thing to do.
  const decoy = new URL(testConnectionString())
  decoy.pathname = '/neondb'
  decoy.searchParams.set('application_name', TEST_DATABASE)
  assert.ok(decoy.toString().includes(TEST_DATABASE), 'the decoy must mention the test database')

  await assert.rejects(
    () => connectToTestDatabase(decoy.toString()),
    (err) => {
      assert.match(err.message, /REFUSING TO RUN/)
      assert.match(err.message, /neondb/, 'it must report what the server actually said')
      return true
    },
    'a guard that trusts the connection string would wrongly allow this',
  )
})

test('the guard allows the test database', async () => {
  const client = await connectToTestDatabase()
  const r = await client.query('select current_database() as db')
  assert.equal(r.rows[0].db, TEST_DATABASE)
  await client.end()
})

test('the schema the suite depends on is present in the test database', async () => {
  const client = await connectToTestDatabase()
  const r = await client.query(
    "select table_name from information_schema.tables where table_schema = 'public'",
  )
  const names = r.rows.map((row) => row.table_name).sort()
  for (const expected of [
    'alert_preferences',
    'event_deliveries',
    'events',
    'schema_migrations',
    'sessions',
    'sign_in_tokens',
    'users',
    'watch_items',
  ]) {
    assert.ok(names.includes(expected), `expected table ${expected}; found ${names.join(', ')}`)
  }
  await client.end()
})
