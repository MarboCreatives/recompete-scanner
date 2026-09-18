// The scanner's half of the schema: migration 0004_scanner.sql.
//
// Two things are checked here and they are different in kind.
//
//   1. THE ROLE. `scanner_writer` is the identity the weekly scan connects as.
//      What matters is not what it can do but what it CANNOT: the six tables
//      that describe people must refuse it. A grant list is easy to write and
//      easy to get subtly wrong, and the failure is silent - a role with too
//      much works perfectly until the day its connection string leaks out of a
//      public repository's Actions secret.
//
//      These cases run under `SET ROLE scanner_writer`, which makes
//      current_user the role and therefore applies exactly the role's
//      privileges. That is not the same event as a real connection, so the real
//      connection was done too, once, by hand on 17 September 2026: the role was
//      given LOGIN and a generated password, connected to over the Neon
//      endpoint, every case below was run across that connection with identical
//      results, and the role was then set back to NOLOGIN with no password. The
//      results are in PROGRESS.md. SET ROLE is what is committed because it
//      needs no second secret to run in CI, and a check that cannot run is not
//      a check.
//
//   2. THE TRIPWIRES. Every CHECK constraint 0004 adds is fired here on a row
//      that violates it. CODING-STANDARDS 3: a check that has never been
//      observed to fail is not known to work. A constraint is the one place a
//      future code path cannot route around, which is the whole reason for
//      writing one, and which is worth nothing if it was written wrong.
//
// Both need a server on recompete_test. See app/db/README.md.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectToTestDatabase } from './helpers.mjs'

// The literal the site substitutes for a private individual's name
// (build_site.PERSON_LABEL), which contract_snapshot_withheld_pairing spells
// out. Written here as its own constant so that the day it changes, this file
// says where the other copy lives.
const PERSON_LABEL = 'Individual supplier (name withheld)'

const SCANNER_TABLES = ['contract_snapshot', 'contract_refs', 'scan_runs']
const PERSONAL_TABLES = [
  'users',
  'sessions',
  'sign_in_tokens',
  'watch_items',
  'alert_preferences',
  'event_deliveries',
]

// 42501 is insufficient_privilege. Asserting the CODE and not the message is
// deliberate: the message names the table, and matching on prose makes a test
// that fails when PostgreSQL rewords itself.
const INSUFFICIENT_PRIVILEGE = '42501'
const CHECK_VIOLATION = '23514'
const FOREIGN_KEY_VIOLATION = '23503'
const UNIQUE_VIOLATION = '23505'

/** FK-safe order: refs point at snapshot, both point at runs, events point at runs. */
async function clearScannerTables(client) {
  await client.query('delete from events')
  await client.query('delete from contract_refs')
  await client.query('delete from contract_snapshot')
  await client.query('delete from scan_runs')
}

/**
 * Like helpers.withDatabase, but tidies the scanner tables rather than the app
 * ones, and does not truncate: `scan_runs` is referenced by three tables and a
 * cascading truncate here would quietly empty them too.
 */
async function withScannerDatabase(fn) {
  const client = await connectToTestDatabase()
  try {
    await clearScannerTables(client)
    return await fn(client)
  } finally {
    try {
      await client.query('reset role')
      await clearScannerTables(client)
    } catch {
      // Tidying failed; closing the connection still matters more.
    }
    await client.end().catch(() => {})
  }
}

/** Run one statement and return the SQLSTATE it was refused with, or null. */
async function refusalCode(client, sql, params) {
  try {
    await client.query(sql, params)
    return null
  } catch (err) {
    return err?.code ?? 'UNKNOWN'
  }
}

/** A scan_runs row to hang other rows off. Returns its id. */
async function makeRun(client, status = 'baseline') {
  const r = await client.query(
    `insert into scan_runs (status, source_rows, live_contracts)
     values ($1, 10, 5) returning id`,
    [status],
  )
  return r.rows[0].id
}

/** A valid contract_snapshot row, with any field overridable. */
function snapshotRow(runId, over = {}) {
  return {
    contract_key: 'org-a::PID-001',
    buyer_org_code: 'org-a',
    reference_number: 'REF-001',
    buyer_org: 'A Department | Un ministere',
    vendor_key: 'acme widgets',
    vendor_display: 'Acme Widgets Inc',
    category_key: 'management consulting',
    contract_value: '250000.00',
    end_date: '2027-03-31',
    amendment_count: 1,
    first_seen_run: runId,
    last_seen_run: runId,
    ...over,
  }
}

async function insertSnapshot(client, row) {
  const cols = Object.keys(row)
  const ph = cols.map((_, i) => `$${i + 1}`).join(', ')
  return refusalCode(
    client,
    `insert into contract_snapshot (${cols.join(', ')}) values (${ph})`,
    cols.map((c) => row[c]),
  )
}

// --------------------------------------------------------------------------
// 1. The role
// --------------------------------------------------------------------------

test('the whole privilege matrix is what 0004 says it is, table by table', async () => {
  await withScannerDatabase(async (client) => {
    // The executing cases below cover the statements the scanner actually runs.
    // This covers every remaining cell, which is where a stray grant would hide:
    // nothing runs DELETE on scan_runs, so nothing would ever notice if the role
    // could. Asking has_table_privilege is the privilege system answering about
    // itself, which is an independent answer from the GRANT statements that are
    // under test.
    const expected = {
      users: '',
      sessions: '',
      sign_in_tokens: '',
      watch_items: '',
      alert_preferences: '',
      event_deliveries: '',
      contract_snapshot: 'SELECT INSERT UPDATE',
      contract_refs: 'SELECT INSERT UPDATE',
      scan_runs: 'SELECT INSERT UPDATE',
      events: 'SELECT INSERT',
    }

    for (const [table, want] of Object.entries(expected)) {
      const r = (
        await client.query(
          `select has_table_privilege('scanner_writer', $1, 'SELECT')   as "SELECT",
                  has_table_privilege('scanner_writer', $1, 'INSERT')   as "INSERT",
                  has_table_privilege('scanner_writer', $1, 'UPDATE')   as "UPDATE",
                  has_table_privilege('scanner_writer', $1, 'DELETE')   as "DELETE",
                  has_table_privilege('scanner_writer', $1, 'TRUNCATE') as "TRUNCATE",
                  has_table_privilege('scanner_writer', $1, 'REFERENCES') as "REFERENCES",
                  has_table_privilege('scanner_writer', $1, 'TRIGGER')  as "TRIGGER"`,
          [table],
        )
      ).rows[0]
      const got = Object.entries(r)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(' ')
      assert.equal(got, want, `privileges on ${table}`)
    }
  })
})

test('scanner_writer is refused every table that describes a person', async () => {
  await withScannerDatabase(async (client) => {
    await client.query('set role scanner_writer')
    assert.equal(
      (await client.query('select current_user as u')).rows[0].u,
      'scanner_writer',
      'SET ROLE did not take effect, so nothing below would be testing the role',
    )

    for (const table of PERSONAL_TABLES) {
      assert.equal(
        await refusalCode(client, `select * from ${table} limit 1`),
        INSUFFICIENT_PRIVILEGE,
        `scanner_writer can READ ${table}. It writes public facts about contracts ` +
          'and has no business reading who is watching them.',
      )
    }

    // The write is checked separately from the read because they are separate
    // grants: a role can be given INSERT without SELECT, so a refused read does
    // not by itself prove a refused write.
    assert.equal(
      await refusalCode(
        client,
        `insert into watch_items (user_id, kind, target_key)
         values ('00000000-0000-0000-0000-000000000000', 'contract', 'org-a,REF-001')`,
      ),
      INSUFFICIENT_PRIVILEGE,
      'scanner_writer can WRITE watch_items. M2-DESIGN 5.2 exists precisely so ' +
        'that it never needs to.',
    )
  })
})

test('scanner_writer can write every scanner table, and only insert on events', async () => {
  await withScannerDatabase(async (client) => {
    // Scaffolding made by the owner, so the inserts below are testing the
    // role's grants rather than its ability to build its own fixtures.
    const runId = await makeRun(client)

    await client.query('set role scanner_writer')

    assert.equal(
      await refusalCode(
        client,
        `insert into scan_runs (status, source_rows, live_contracts) values ('ok', 1, 1)`,
      ),
      null,
      'scanner_writer cannot insert a scan_runs row. If this fails with 42501 on ' +
        'the SEQUENCE rather than the table, the GRANT USAGE ON SEQUENCE is missing.',
    )

    const row = snapshotRow(runId)
    assert.equal(await insertSnapshot(client, row), null, 'insert into contract_snapshot')

    assert.equal(
      await refusalCode(
        client,
        `update contract_snapshot set last_seen_run = $1 where contract_key = $2`,
        [runId, row.contract_key],
      ),
      null,
      'update contract_snapshot',
    )

    assert.equal(
      await refusalCode(
        client,
        `insert into contract_refs (buyer_org_code, reference_number, contract_key, first_seen_run)
         values ($1, $2, $3, $4)`,
        [row.buyer_org_code, row.reference_number, row.contract_key, runId],
      ),
      null,
      'insert into contract_refs',
    )

    assert.equal(
      await refusalCode(
        client,
        `insert into events (event_type, contract_ref, dedupe_key, occurred_at,
                             contract_key, scan_run_id)
         values ('EXPIRY_MOVED', 'org-a,REF-001', 'k1', now(), $1, $2)`,
        [row.contract_key, runId],
      ),
      null,
      'insert into events',
    )

    // An event is a fact that was true when it was detected. Rewriting or
    // removing one after the fact is not something the scanner should be able
    // to do, and DELETE is how a bug becomes lost history.
    assert.equal(
      await refusalCode(client, `update events set contract_key = 'x' where false`),
      INSUFFICIENT_PRIVILEGE,
      'scanner_writer can UPDATE events',
    )
    assert.equal(
      await refusalCode(client, 'delete from events where false'),
      INSUFFICIENT_PRIVILEGE,
      'scanner_writer can DELETE events',
    )
    assert.equal(
      await refusalCode(client, 'delete from contract_snapshot where false'),
      INSUFFICIENT_PRIVILEGE,
      'scanner_writer can DELETE contract_snapshot. Rows are updated in place; a ' +
        'contract that leaves the data keeps its row so a watch on it still resolves.',
    )
  })
})

// --------------------------------------------------------------------------
// 2. The tripwires — scan_runs
// --------------------------------------------------------------------------

test('scan_runs refuses a status outside the four', async () => {
  await withScannerDatabase(async (client) => {
    assert.equal(
      await refusalCode(client, `insert into scan_runs (status) values ('finished')`),
      CHECK_VIOLATION,
    )
    for (const status of ['baseline', 'ok', 'failed']) {
      assert.equal(
        await refusalCode(client, `insert into scan_runs (status) values ($1)`, [status]),
        null,
        `${status} is one of the four and must be accepted`,
      )
    }
  })
})

test('scan_runs refuses a refusal reason that is free text', async () => {
  await withScannerDatabase(async (client) => {
    assert.equal(
      await refusalCode(
        client,
        `insert into scan_runs (status, refusal_reason)
         values ('refused', 'the download looked wrong for Acme Widgets Inc')`,
      ),
      CHECK_VIOLATION,
      'free text in refusal_reason is how a supplier name reaches a public table',
    )
    for (const code of ['live_count_drop', 'gone_rate', 'drift', 'self_test']) {
      assert.equal(
        await refusalCode(
          client,
          `insert into scan_runs (status, refusal_reason) values ('refused', $1)`,
          [code],
        ),
        null,
        `${code} is one of the four refusal rules in M2-DESIGN 6.6`,
      )
    }
  })
})

test('scan_runs refuses a refusal with no reason, and a reason with no refusal', async () => {
  await withScannerDatabase(async (client) => {
    assert.equal(
      await refusalCode(client, `insert into scan_runs (status) values ('refused')`),
      CHECK_VIOLATION,
      'a refused run with no reason is a run nobody can act on',
    )
    assert.equal(
      await refusalCode(
        client,
        `insert into scan_runs (status, refusal_reason) values ('ok', 'drift')`,
      ),
      CHECK_VIOLATION,
      'a reason on an ok run means the writer took the refusal branch and committed anyway',
    )
  })
})

test('scan_runs refuses a finish before its start, and a negative count', async () => {
  await withScannerDatabase(async (client) => {
    assert.equal(
      await refusalCode(
        client,
        `insert into scan_runs (status, started_at, finished_at)
         values ('ok', timestamptz '2026-09-17 12:00Z', timestamptz '2026-09-17 11:00Z')`,
      ),
      CHECK_VIOLATION,
    )
    assert.equal(
      await refusalCode(
        client,
        `insert into scan_runs (status, live_contracts) values ('ok', -1)`,
      ),
      CHECK_VIOLATION,
    )
    assert.equal(
      await refusalCode(
        client,
        `insert into scan_runs (status, source_rows) values ('ok', -1)`,
      ),
      CHECK_VIOLATION,
    )
  })
})

test('scan_runs refuses events_by_type that is not an object of counts', async () => {
  await withScannerDatabase(async (client) => {
    for (const bad of ['[]', '"EXPIRY_MOVED"', '3']) {
      assert.equal(
        await refusalCode(
          client,
          `insert into scan_runs (status, events_by_type) values ('ok', $1::jsonb)`,
          [bad],
        ),
        CHECK_VIOLATION,
        `events_by_type accepted ${bad}, which is not a map of counts`,
      )
    }
    assert.equal(
      await refusalCode(
        client,
        `insert into scan_runs (status, events_by_type)
         values ('ok', '{"EXPIRY_MOVED": 2}'::jsonb)`,
      ),
      null,
    )
  })
})

// --------------------------------------------------------------------------
// 3. The tripwires — contract_snapshot
// --------------------------------------------------------------------------

test('contract_snapshot refuses half-applied suppression, both ways round', async () => {
  await withScannerDatabase(async (client) => {
    const runId = await makeRun(client)

    // A blank key with a real name: the name survived suppression.
    assert.equal(
      await insertSnapshot(
        client,
        snapshotRow(runId, { vendor_key: '', vendor_display: 'Dana Quilleran' }),
      ),
      CHECK_VIOLATION,
      'a blank vendor_key with a real name means suppression blanked the key and ' +
        'left the name, which is the half that matters',
    )

    // A real key with the withheld label: the person still has a watchable
    // identity and a supplier page, which is what blanking the key prevents.
    assert.equal(
      await insertSnapshot(
        client,
        snapshotRow(runId, { vendor_key: 'dana quilleran', vendor_display: PERSON_LABEL }),
      ),
      CHECK_VIOLATION,
    )

    // Both halves applied: accepted.
    assert.equal(
      await insertSnapshot(
        client,
        snapshotRow(runId, { vendor_key: '', vendor_display: PERSON_LABEL }),
      ),
      null,
      `the exact string is load-bearing. If this fails, PERSON_LABEL here and the ` +
        `literal in 0004_scanner.sql have drifted apart.`,
    )
  })
})

test('contract_snapshot refuses the buyer_name field in any text column', async () => {
  await withScannerDatabase(async (client) => {
    const runId = await makeRun(client)

    // Every text column, one at a time, because a constraint that names six
    // columns can easily be written naming five.
    const columns = [
      'contract_key',
      'buyer_org_code',
      'reference_number',
      'buyer_org',
      'vendor_key',
      'category_key',
    ]
    for (const column of columns) {
      assert.equal(
        await insertSnapshot(client, snapshotRow(runId, { [column]: 'buyer_name: someone' })),
        CHECK_VIOLATION,
        `${column} accepted the buyer_name field`,
      )
    }

    // vendor_display separately: it has to carry a value that also satisfies
    // the pairing constraint, so a plain overwrite would fail for the wrong
    // reason and prove nothing.
    assert.equal(
      await insertSnapshot(
        client,
        snapshotRow(runId, { vendor_key: 'x', vendor_display: 'X buyer_name Ltd' }),
      ),
      CHECK_VIOLATION,
      'vendor_display accepted the buyer_name field',
    )

    // The camelCase spelling and the case-insensitivity, both of which
    // events_no_buyer_name in 0001 also covers.
    assert.equal(
      await insertSnapshot(client, snapshotRow(runId, { category_key: 'buyerName' })),
      CHECK_VIOLATION,
      'the camelCase spelling walked straight through',
    )
    assert.equal(
      await insertSnapshot(client, snapshotRow(runId, { category_key: 'BUYER_NAME' })),
      CHECK_VIOLATION,
      'the constraint is case-sensitive, so any other capitalisation gets through',
    )
  })
})

test('contract_snapshot refuses runs out of order and an unset amendment count', async () => {
  await withScannerDatabase(async (client) => {
    const first = await makeRun(client)
    const second = await makeRun(client, 'ok')

    assert.equal(
      await insertSnapshot(
        client,
        snapshotRow(first, { first_seen_run: second, last_seen_run: first }),
      ),
      CHECK_VIOLATION,
      'first_seen_run is set once and last_seen_run only moves forward; the pair ' +
        'going backwards means an update wrote the wrong column',
    )

    assert.equal(
      await insertSnapshot(client, snapshotRow(first, { amendment_count: 0 })),
      CHECK_VIOLATION,
      'deduplicate() counts the winning row too, so the floor is 1; a 0 means the ' +
        'count was never set',
    )
  })
})

test('contract_snapshot will not point at a run that does not exist', async () => {
  await withScannerDatabase(async (client) => {
    // Each of the two run columns is checked on its own, with the OTHER one
    // pointing at a run that really exists. Two earlier versions of this case
    // were wrong and the break harness is what found both.
    //
    // The first pointed only first_seen_run at a missing id, which left it
    // above last_seen_run, so contract_snapshot_run_order refused the row and
    // the foreign key was never reached: 23514, not 23503.
    //
    // The second pointed BOTH at the same missing id. That satisfied the
    // ordering rule and did return 23503 — but from whichever foreign key
    // PostgreSQL happened to check first. Dropping first_seen_run's key on its
    // own left the case passing, because last_seen_run's key was still there to
    // refuse the row. It proved one of the two existed, which is not what it
    // says it proves.
    //
    // Two real runs are made and then one is deleted, so the missing id is
    // genuinely absent AND still in the right order relative to the live one.
    const gone = await makeRun(client)
    const alive = await makeRun(client, 'ok')
    assert.ok(gone < alive, 'bigserial should be handing out increasing ids')

    await client.query('delete from scan_runs where id = $1', [gone])
    assert.equal(
      await insertSnapshot(
        client,
        snapshotRow(null, { first_seen_run: gone, last_seen_run: alive }),
      ),
      FOREIGN_KEY_VIOLATION,
      'first_seen_run may point at a run that is not there',
    )

    const alsoGone = await makeRun(client, 'ok')
    await client.query('delete from scan_runs where id = $1', [alsoGone])
    assert.ok(alive < alsoGone, 'the second missing id must be the LATER of the pair')
    assert.equal(
      await insertSnapshot(
        client,
        snapshotRow(null, { first_seen_run: alive, last_seen_run: alsoGone }),
      ),
      FOREIGN_KEY_VIOLATION,
      'last_seen_run may point at a run that is not there',
    )
  })
})

// --------------------------------------------------------------------------
// 4. The tripwires — contract_refs
// --------------------------------------------------------------------------

test('contract_refs refuses half an empty watch key', async () => {
  await withScannerDatabase(async (client) => {
    const runId = await makeRun(client)
    const row = snapshotRow(runId)
    assert.equal(await insertSnapshot(client, row), null)

    const insertRef = (org, ref) =>
      refusalCode(
        client,
        `insert into contract_refs (buyer_org_code, reference_number, contract_key, first_seen_run)
         values ($1, $2, $3, $4)`,
        [org, ref, row.contract_key, runId],
      )

    assert.equal(await insertRef('', 'REF-001'), CHECK_VIOLATION, 'an empty org half')
    assert.equal(await insertRef('org-a', ''), CHECK_VIOLATION, 'an empty reference half')
    assert.equal(await insertRef('org-a', 'REF-001'), null, 'both halves present')
  })
})

test('contract_refs is keyed on the pair, which is the watch key', async () => {
  await withScannerDatabase(async (client) => {
    const runId = await makeRun(client)
    const a = snapshotRow(runId)
    const b = snapshotRow(runId, { contract_key: 'org-b::PID-002', buyer_org_code: 'org-b' })
    assert.equal(await insertSnapshot(client, a), null)
    assert.equal(await insertSnapshot(client, b), null)

    const insertRef = (org, ref, key) =>
      refusalCode(
        client,
        `insert into contract_refs (buyer_org_code, reference_number, contract_key, first_seen_run)
         values ($1, $2, $3, $4)`,
        [org, ref, key, runId],
      )

    assert.equal(await insertRef('org-a', 'REF-001', a.contract_key), null)

    // G23: the same reference number under a different department is a
    // different contract and must be storable.
    assert.equal(
      await insertRef('org-b', 'REF-001', b.contract_key),
      null,
      'the same reference number under another department was refused, which ' +
        'would lose one of the two contracts',
    )

    // The same pair twice is the same watch key pointing two ways.
    assert.equal(
      await insertRef('org-a', 'REF-001', b.contract_key),
      UNIQUE_VIOLATION,
      'one watch key resolved to two contracts',
    )
  })
})

test('contract_refs will not point at a contract that is not in the snapshot', async () => {
  await withScannerDatabase(async (client) => {
    const runId = await makeRun(client)
    assert.equal(
      await refusalCode(
        client,
        `insert into contract_refs (buyer_org_code, reference_number, contract_key, first_seen_run)
         values ('org-a', 'REF-001', 'org-a::NOT-THERE', $1)`,
        [runId],
      ),
      FOREIGN_KEY_VIOLATION,
      'a watch key that resolves to nothing is worse than one that resolves to ' +
        'the wrong thing, because nothing explains it',
    )
  })
})

// --------------------------------------------------------------------------
// 5. The two new events columns
// --------------------------------------------------------------------------

test('events carries a contract key and the run that found it, and both stay optional', async () => {
  await withScannerDatabase(async (client) => {
    const runId = await makeRun(client)

    assert.equal(
      await refusalCode(
        client,
        `insert into events (event_type, contract_ref, dedupe_key, occurred_at,
                             contract_key, scan_run_id)
         values ('EXPIRY_MOVED', 'org-a,REF-002', 'k-both', now(), 'org-a::PID-001', $1)`,
        [runId],
      ),
      null,
    )

    // contract_ref holds the reference AS AT THE EVENT and contract_key holds
    // the identity that survives an amendment. Storing both is the point: the
    // source link needs the first, the feed joins on the second.
    const row = (
      await client.query(`select contract_ref, contract_key, scan_run_id from events
                          where dedupe_key = 'k-both'`)
    ).rows[0]
    assert.equal(row.contract_ref, 'org-a,REF-002')
    assert.equal(row.contract_key, 'org-a::PID-001')
    assert.equal(String(row.scan_run_id), String(runId))

    // Nullable, because a NEW_AWARD is about a vendor and because every event
    // written before 0004 has neither.
    assert.equal(
      await refusalCode(
        client,
        `insert into events (event_type, vendor_key, dedupe_key, occurred_at)
         values ('NEW_AWARD', 'acme widgets', 'k-neither', now())`,
      ),
      null,
      'adding the columns made the old shape of event unwritable',
    )
  })
})

test('events will not point at a run that does not exist', async () => {
  await withScannerDatabase(async (client) => {
    assert.equal(
      await refusalCode(
        client,
        `insert into events (event_type, contract_ref, dedupe_key, occurred_at, scan_run_id)
         values ('VALUE_CHANGED', 'org-a,REF-001', 'k-badrun', now(), 9999999)`,
      ),
      FOREIGN_KEY_VIOLATION,
    )
  })
})
