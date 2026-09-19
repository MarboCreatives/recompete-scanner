// A migration gives up on a lock instead of queueing every reader behind it.
//
// Outside review, 18 September 2026: 0004's ALTER TABLE events takes ACCESS
// EXCLUSIVE, and migrate.mjs holds it until COMMIT. Measured on recompete_test:
// one open reader makes the ALTER wait, and every later reader of events then
// waits behind the ALTER, not behind the reader. So migrate.mjs sends a lock
// timeout first inside every file's transaction.
//
// migrate.mjs is read as TEXT here. Importing it would run the migration.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { connectToTestDatabase } from './helpers.mjs'

const SOURCE = readFileSync(new URL('../scripts/migrate.mjs', import.meta.url), 'utf8')

/** The statement migrate.mjs sends, as it is written there. */
function lockTimeoutStatement() {
  const m = SOURCE.match(/^const LOCK_TIMEOUT = "(set local lock_timeout = '(\d+)(ms|s)')"$/m)
  assert.ok(m, 'migrate.mjs does not define LOCK_TIMEOUT as a SET LOCAL lock_timeout')
  const ms = Number(m[2]) * (m[3] === 's' ? 1000 : 1)
  assert.ok(ms > 0 && ms <= 10000, `the lock timeout must be set, and short; it is ${m[2]}${m[3]}`)
  return m[1]
}

test('migrate.mjs bounds the lock wait first in every file, and only for that file', () => {
  lockTimeoutStatement()
  // Straight after begin and before the file's own text, comments aside.
  const code = SOURCE.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.match(code, /await client\.query\('begin'\)\s*await client\.query\(LOCK_TIMEOUT\)\s*await client\.query\(text\)/,
    'LOCK_TIMEOUT must be sent right after begin and before the migration file')
  // A plain SET would outlive the transaction on this one shared connection.
  assert.doesNotMatch(code, /\bset\s+lock_timeout\b/i, 'a plain SET lock_timeout outlives its file')
})

test('with that bound, an ALTER on events gives up instead of queueing', async () => {
  const statement = lockTimeoutStatement()
  const holder = await connectToTestDatabase()
  const migration = await connectToTestDatabase()
  try {
    // An ordinary reader, mid-transaction.
    await holder.query('begin')
    await holder.query('select 1 from events limit 1')

    await migration.query("set statement_timeout = '15s'")
    await migration.query('begin')
    await migration.query(statement)
    const started = Date.now()
    const err = await migration
      .query('alter table events add column lock_probe int')
      .then(() => null, (e) => e)
    // 55P03 is lock_not_available. Without the bound the ALTER waits until the
    // statement timeout (57014) or for ever.
    assert.equal(err?.code, '55P03', 'the ALTER did not give up on the lock')
    assert.ok(Date.now() - started < 10000, 'the ALTER gave up, but only after waiting too long')
  } finally {
    await migration.query('rollback').catch(() => {})
    await holder.query('rollback').catch(() => {})
    await migration.end().catch(() => {})
    await holder.end().catch(() => {})
  }
})
