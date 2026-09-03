// Applies db/migrations/*.sql once each, in name order, over the direct
// (non-pooled) connection. Run by the Vercel build and by CI.
//
// This file reads NO env file. DATABASE_URL_UNPOOLED must already be present in
// the shell. Nobody migrates a database from a file they did not read; the
// Development value in a pulled .env.local points at the same database
// production uses, so an env file here would silently migrate production.
//
// Three measured facts shape the error handling. All were observed against the
// live database on 2 September 2026, not taken from documentation.
//
//   1. A wrong host rejects connect() with an ErrorEvent whose message is the
//      empty string, with no name, no code and no own keys. So a caught error
//      cannot be relied on to say anything; this script prints its own
//      diagnostic unconditionally.
//   2. A wrong password does NOT reject connect(). connect() resolves, and the
//      authentication failure arrives later as an uncaught exception that kills
//      the process with a driver stack trace. So an 'error' listener is attached
//      BEFORE connecting, and a trivial round trip is forced immediately after,
//      which turns a credential fault into a caught, explained failure.
//   3. Postgres puts the offending value in the error's detail field, for
//      example "Key (email)=(someone@example.com) already exists". So only the
//      SQLSTATE code is ever printed; message, detail, hint and where are not.

import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@neondatabase/serverless'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')

// One arbitrary but fixed number. Two builds cannot migrate at once.
const ADVISORY_LOCK_KEY = 8571394

function fail(sentence, code) {
  console.error('')
  console.error('MIGRATION FAILED')
  console.error(sentence)
  if (code) console.error(`PostgreSQL error code: ${code}`)
  console.error('')
  console.error('This script reads DATABASE_URL_UNPOOLED from the environment.')
  console.error('It must be the direct connection string, not the -pooler one.')
  process.exit(1)
}

function hostOf(url) {
  // The host is printed to help diagnose a wrong target. The password is not.
  try {
    return new URL(url).hostname
  } catch {
    return '(could not be parsed as a URL)'
  }
}

const connectionString = process.env.DATABASE_URL_UNPOOLED
if (!connectionString) {
  fail('DATABASE_URL_UNPOOLED is not set in the environment.')
}

const host = hostOf(connectionString)
console.log(`Migrating. Host: ${host}. Directory: ${MIGRATIONS_DIR}`)

const client = new Client({ connectionString })

// Attached before connect(), deliberately. A bad password surfaces here and
// nowhere else; without this listener it is an uncaught exception.
client.on('error', (err) => {
  fail(
    `The database rejected the connection to ${host} after it appeared to open. ` +
      'The most likely cause is a wrong password in DATABASE_URL_UNPOOLED.',
    err?.code,
  )
})

try {
  await client.connect()
  // Forces a real round trip. connect() resolving does not prove the credential
  // is good; this does.
  await client.query('select 1')
} catch (err) {
  // 28P01 is invalid_password. It arrives here rather than from connect(),
  // because connect() resolves on a bad credential; the forced round trip above
  // is what surfaces it. Saying "the host may be wrong" here would be untrue.
  if (err?.code === '28P01') {
    fail(
      `The database at ${host} refused the credentials. The password in ` +
        'DATABASE_URL_UNPOOLED is wrong. The host and the database name were ' +
        'reachable, so only the credentials need changing.',
      err.code,
    )
  }
  fail(
    `Could not reach the database at ${host}. The host may be wrong, or the ` +
      'network may be blocked. The driver reported no details for this case.',
    err?.code,
  )
}

let exitCode = 0
try {
  // The lock is taken FIRST, before the migrations table is created. CREATE
  // TABLE IF NOT EXISTS is not race-safe in Postgres: two simultaneous first
  // runs can collide on a system index and raise a duplicate-key error rather
  // than being absorbed. A Vercel build and a CI run are separate concurrency
  // groups and can overlap.
  await client.query(`select pg_advisory_lock(${ADVISORY_LOCK_KEY})`)

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text        PRIMARY KEY,
      checksum    text        NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `)

  const applied = new Map()
  const rows = await client.query('select name, checksum from schema_migrations')
  for (const row of rows.rows) applied.set(row.name, row.checksum)

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  if (files.length === 0) fail(`No .sql files found in ${MIGRATIONS_DIR}.`)

  let appliedCount = 0
  for (const name of files) {
    const text = readFileSync(join(MIGRATIONS_DIR, name), 'utf8')
    const checksum = createHash('sha256').update(text).digest('hex')
    const previous = applied.get(name)

    if (previous !== undefined) {
      if (previous !== checksum) {
        fail(
          `${name} has already been applied, but its contents have changed since. ` +
            'An applied migration is never edited; add a new migration file instead. ' +
            'See db/README.md.',
        )
      }
      console.log(`  ${name}: already applied`)
      continue
    }

    console.log(`  ${name}: applying`)
    try {
      await client.query('begin')
      await client.query(text)
      await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [
        name,
        checksum,
      ])
      await client.query('commit')
      appliedCount += 1
      console.log(`  ${name}: applied`)
    } catch (err) {
      try {
        await client.query('rollback')
      } catch {
        // The rollback failing does not change what we report.
      }
      fail(
        `${name} failed to apply and was rolled back; the database is unchanged. ` +
          'Look up the error code below to see which statement Postgres refused. ' +
          'The error text itself is withheld, because Postgres includes the ' +
          'offending row value in it and that can be personal data.',
        err?.code,
      )
    }
  }

  console.log(
    appliedCount === 0
      ? 'Nothing to do; the database is already up to date.'
      : `Done. ${appliedCount} migration${appliedCount === 1 ? '' : 's'} applied.`,
  )
} catch (err) {
  exitCode = 1
  fail('The migration run failed before any file was applied.', err?.code)
} finally {
  try {
    await client.query(`select pg_advisory_unlock(${ADVISORY_LOCK_KEY})`)
  } catch {
    // Ending the session releases the lock anyway.
  }
  await client.end().catch(() => {})
}

process.exit(exitCode)
