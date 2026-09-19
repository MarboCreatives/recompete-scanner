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
import { readdirSync, readFileSync } from 'node:fs'
import { connectToTestDatabase } from './helpers.mjs'

const MIGRATIONS = new URL('../db/migrations/', import.meta.url)
const MIGRATION_0004 = readFileSync(new URL('0004_scanner.sql', MIGRATIONS), 'utf8')

/** A migration's SQL with its -- comments removed, so prose cannot trip a text check. */
function codeOf(sql) {
  return sql.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n')
}

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

/**
 * FK-safe order: refs point at snapshot, both point at runs, events point at runs.
 *
 * `delete from events` has no WHERE: it empties the whole table, including rows
 * another test file wrote. That is safe only because the test files run one at
 * a time (`--test-concurrency=1` in app/package.json, which
 * tests/suite-order.test.mjs pins); helpers.truncateAll, used by every other
 * test file that writes to the database, relies on the same thing. Node runs
 * test files in parallel without it, so any other runner must pass the flag.
 */
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
      schema_migrations: '',
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
                  has_table_privilege('scanner_writer', $1, 'TRIGGER')  as "TRIGGER",
                  has_table_privilege('scanner_writer', $1, 'MAINTAIN') as "MAINTAIN"`,
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

// Every schema a later migration could add, and none of PostgreSQL's own.
const USER_SCHEMA = `n.nspname <> 'information_schema' and n.nspname not like 'pg\\_%'`
const WHO = `case when x.grantee = 0 then 'PUBLIC' else x.grantee::regrole::text end`
const GRANTABLE = `case when x.is_grantable then ' WITH GRANT OPTION' else '' end`

// The whole of what the role holds, read from the catalogs rather than from a
// hand-kept list. Outside review, 18 September 2026: the matrix above names ten
// tables, so a grant on any other table, a column grant, a default privilege or
// a membership went unseen. The matrix stays, because has_table_privilege counts
// EFFECTIVE privileges and so sees a membership such as pg_read_all_data that no
// ACL listing shows; the two see different things.
//
// information_schema.column_privileges is deliberately not used: it expands
// every table grant per column, so it lists 97 rows on a correct database.
// pg_attribute.attacl holds only explicit column grants.
const CLOSED_WORLD = [
  {
    what: 'scanner_writer carries no elevated attribute',
    sql: `select format('super=%s createdb=%s createrole=%s replication=%s bypassrls=%s',
                 rolsuper::text, rolcreatedb::text, rolcreaterole::text,
                 rolreplication::text, rolbypassrls::text) as x
          from pg_roles where rolname = 'scanner_writer'`,
    want: ['super=false createdb=false createrole=false replication=false bypassrls=false'],
  },
  {
    what: 'scanner_writer is a member of no role: a membership brings that role\'s privileges',
    sql: `select roleid::regrole::text as x from pg_auth_members where member = 'scanner_writer'::regrole`,
    want: [],
  },
  {
    what: 'the table, view and sequence grants reaching scanner_writer, directly or through PUBLIC, are exactly 0004\'s',
    sql: `select format('%s.%s %s %s%s', n.nspname, c.relname, ${WHO}, x.privilege_type, ${GRANTABLE}) as x
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          cross join lateral aclexplode(c.relacl) x
          where x.grantee in (0, 'scanner_writer'::regrole) and ${USER_SCHEMA}`,
    want: [
      'public.contract_refs scanner_writer INSERT', 'public.contract_refs scanner_writer SELECT',
      'public.contract_refs scanner_writer UPDATE',
      'public.contract_snapshot scanner_writer INSERT', 'public.contract_snapshot scanner_writer SELECT',
      'public.contract_snapshot scanner_writer UPDATE',
      'public.events scanner_writer INSERT', 'public.events scanner_writer SELECT',
      'public.scan_runs scanner_writer INSERT', 'public.scan_runs scanner_writer SELECT',
      'public.scan_runs scanner_writer UPDATE',
      'public.scan_runs_id_seq scanner_writer USAGE',
    ],
  },
  {
    what: 'no column-level grant reaches scanner_writer or PUBLIC',
    sql: `select format('%s.%s %s %s', c.relname, a.attname, ${WHO}, x.privilege_type) as x
          from pg_attribute a
          join pg_class c on c.oid = a.attrelid
          join pg_namespace n on n.oid = c.relnamespace
          cross join lateral aclexplode(a.attacl) x
          where x.grantee in (0, 'scanner_writer'::regrole) and ${USER_SCHEMA}`,
    want: [],
  },
  {
    // PUBLIC only for tables and sequences: a default ACL on functions or types
    // carries PUBLIC EXECUTE or USAGE as normal. Neon's own cloud_admin entries
    // grant to neon_superuser, so a plain row count would fail here.
    what: 'no ALTER DEFAULT PRIVILEGES hands future tables to scanner_writer or PUBLIC',
    sql: `select format('%s %s %s %s %s', d.defaclrole::regrole,
                   case when d.defaclnamespace = 0 then '*' else d.defaclnamespace::regnamespace::text end,
                   d.defaclobjtype, ${WHO}, x.privilege_type) as x
          from pg_default_acl d cross join lateral aclexplode(d.defaclacl) x
          where x.grantee = 'scanner_writer'::regrole
             or (x.grantee = 0 and d.defaclobjtype in ('r', 'S'))`,
    want: [],
  },
  {
    what: 'schema privileges reaching scanner_writer or PUBLIC are USAGE on public only',
    sql: `select format('%s %s %s%s', n.nspname, ${WHO}, x.privilege_type, ${GRANTABLE}) as x
          from pg_namespace n cross join lateral aclexplode(n.nspacl) x
          where x.grantee in (0, 'scanner_writer'::regrole) and ${USER_SCHEMA}`,
    want: ['public PUBLIC USAGE', 'public scanner_writer USAGE'],
  },
  {
    // Any role, not only the two above: a schema created by a role the scanner
    // could become, or placed first on the search path, would capture the
    // app's unqualified table names. Review of the fixes, 18 September 2026.
    what: 'nobody but a schema\'s owner may CREATE in it',
    sql: `select format('%s %s', n.nspname, ${WHO}) as x
          from pg_namespace n cross join lateral aclexplode(n.nspacl) x
          where x.privilege_type = 'CREATE' and x.grantee <> n.nspowner and ${USER_SCHEMA}`,
    want: [],
  },
  {
    // A NULL datacl means the defaults: PUBLIC may CONNECT and make TEMPORARY
    // tables. Anything more, CREATE above all, lets scanner_writer make its own
    // schema. pg_shdepend below sees only grants that name scanner_writer.
    what: 'PUBLIC holds nothing on this database beyond CONNECT and TEMPORARY',
    sql: `select format('%s %s', ${WHO}, x.privilege_type) as x
          from pg_database d
          cross join lateral aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) x
          where d.datname = current_database() and x.grantee = 0
            and x.privilege_type not in ('CONNECT', 'TEMPORARY')`,
    want: [],
  },
  {
    // A SECURITY DEFINER function runs with its owner's rights, and functions
    // keep PostgreSQL's default PUBLIC EXECUTE. One in public let the role read
    // users while every other check here passed (measured). There are none today.
    what: 'no SECURITY DEFINER function in a user schema is executable by scanner_writer',
    sql: `select p.oid::regprocedure::text as x
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where p.prosecdef and has_function_privilege('scanner_writer', p.oid, 'EXECUTE')
            and ${USER_SCHEMA}`,
    want: [],
  },
  {
    // pg_shdepend records every object whose owner or ACL names the role, of
    // every kind. The backstop for the kinds not listed above. A grant on
    // ANOTHER database is left out: pg_database is shared across the cluster,
    // and production's own grants must not turn this suite red.
    what: 'scanner_writer owns nothing and appears in no other ACL in this database',
    sql: `select format('%s %s %s %s', s.classid::regclass,
                   case when s.classid = 'pg_class'::regclass then
                          (select n.nspname || '.' || c.relname from pg_class c
                             join pg_namespace n on n.oid = c.relnamespace where c.oid = s.objid)
                        when s.classid = 'pg_namespace'::regclass then
                          (select nspname from pg_namespace where oid = s.objid)
                        else s.objid::text end,
                   s.objsubid, s.deptype) as x
          from pg_shdepend s
          where s.refclassid = 'pg_authid'::regclass and s.refobjid = 'scanner_writer'::regrole
            and s.dbid in (0, (select oid from pg_database where datname = current_database()))
            and not (s.classid = 'pg_database'::regclass
                     and s.objid <> (select oid from pg_database where datname = current_database()))`,
    want: [
      'pg_class public.contract_refs 0 a', 'pg_class public.contract_snapshot 0 a',
      'pg_class public.events 0 a', 'pg_class public.scan_runs 0 a',
      'pg_class public.scan_runs_id_seq 0 a', 'pg_namespace public 0 a',
    ],
  },
]

test('scanner_writer holds exactly what 0004 grants, and nothing else', async () => {
  await withScannerDatabase(async (client) => {
    for (const { what, sql, want } of CLOSED_WORLD) {
      const got = (await client.query(sql)).rows.map((r) => r.x).sort()
      assert.deepEqual(got, [...want].sort(), what)
    }
  })
})

test('scanner_writer cannot sign in yet', async () => {
  await withScannerDatabase(async (client) => {
    const r = (
      await client.query(`select rolcanlogin from pg_roles where rolname = 'scanner_writer'`)
    ).rows
    assert.equal(r.length, 1, 'scanner_writer does not exist')
    // A password on a NOLOGIN role cannot be used, so this alone is enough.
    assert.equal(
      r[0].rolcanlogin,
      false,
      'scanner_writer can sign in. Until PR D this must be false: 0004 promises that ' +
        'applying it cannot put a usable credential anywhere. WHEN PR D RUNS THE PLANNED ' +
        'out-of-band ALTER ROLE scanner_writer WITH LOGIN (M2-DESIGN section 12, action 3), ' +
        'this turns true by design, on every database, because the role is cluster-wide: ' +
        'the change that takes that step changes this test with it. The migration-text ' +
        'check below keeps guarding the migrations after that.',
    )
  })
})

test('no migration can give a role a way to sign in, or change an existing role', () => {
  // The permanent half of "applying this file cannot put a usable credential
  // anywhere". The live check above will flip when PR D gives the role LOGIN;
  // this one never should. Comments are stripped first, because 0004's header
  // quotes the out-of-band statement on purpose. \bLOGIN\b cannot match inside
  // NOLOGIN. If a migration ever needs one of these words for something that is
  // not a role, adjust the pattern for that use only.
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  assert.ok(files.length >= 4, 'the migrations must actually be read')
  for (const f of files) {
    const code = codeOf(readFileSync(new URL(f, MIGRATIONS), 'utf8'))
    assert.doesNotMatch(code, /\bLOGIN\b|\bPASSWORD\b|\bCREATE\s+USER\b(?!\s+MAPPING)/i,
      `${f} could give a role a way to sign in`)
    // 0004 must never "normalise" the role: it runs against the cluster again
    // whenever recompete_test is rebuilt, and would switch the production
    // scanner off (see 0004's role comment). Every spelling: ALTER USER and
    // ALTER GROUP are other names for ALTER ROLE, and the first version of this
    // check saw only one of them (review of the fixes, 18 September 2026).
    assert.doesNotMatch(code, /\b(ALTER|DROP)\s+(ROLE|USER|GROUP)\b/i, `${f} changes an existing role`)
  }
})

test('the migrating role can become scanner_writer but does not inherit its grants', async () => {
  await withScannerDatabase(async (client) => {
    // pg_has_role USAGE is true for every path by which current_user would
    // inherit the role's privileges, so a later INHERIT grant made any other
    // way is caught too. The first 0004 granted INHERIT without saying so
    // (outside review, 18 September 2026).
    const r = (
      await client.query(`select pg_has_role(current_user, 'scanner_writer', 'SET')   as can_set,
                                 pg_has_role(current_user, 'scanner_writer', 'USAGE') as inherits`)
    ).rows[0]
    assert.equal(r.can_set, true, 'the suite cannot SET ROLE scanner_writer, so the role cases test nothing')
    assert.equal(r.inherits, false, 'the migrating role silently carries scanner_writer\'s grants')
  })
})

test('0004 absorbs another database creating scanner_writer at the same moment', () => {
  // Text only: proving it by behaviour means committing a CREATE ROLE from a
  // second session, which is a change to the production cluster. The wait was
  // measured to end in unique_violation, not duplicate_object, so both are named.
  const block = codeOf(MIGRATION_0004).match(/DO \$\$[\s\S]*?CREATE ROLE scanner_writer NOLOGIN;[\s\S]*?\n\$\$;/)
  assert.ok(block, 'the DO block that creates scanner_writer was not found')
  assert.match(block[0], /EXCEPTION\s+WHEN\s+duplicate_object\s+OR\s+unique_violation\s+THEN\s+NULL;/)
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

// What scanner/diff.events_by_type() really writes: every type, zeros included.
const ALL_ZERO = '{"EXPIRY_MOVED": 0, "VALUE_CHANGED": 0, "CONTRACT_GONE": 0, "NEW_AWARD": 0}'
const ONE_EACH = '{"EXPIRY_MOVED": 1, "VALUE_CHANGED": 1, "CONTRACT_GONE": 1, "NEW_AWARD": 1}'

test('scan_runs refuses events_by_type that is not an object of counts', async () => {
  await withScannerDatabase(async (client) => {
    // The first version of this case tried only three non-objects, and it
    // passed while a supplier's name could be stored here as a value or as a
    // key (outside review, 18 September 2026). Each line below is refused by
    // at least one clause of the constraint, and every clause is the ONLY one
    // refusing at least one line, so each clause is seen to work. (An earlier
    // wording said each line is refused by exactly one; four are refused by
    // two or three. Measured, 18 September 2026.)
    const bad = [
      '[]', '"EXPIRY_MOVED"', '3',                                   // not an object
      '{"vendor": "Invented Supplier Inc"}',                          // a name as a value
      '{"Invented Supplier Inc": 1}', '{"buyer_name": 1}',            // a name as a key
      ALL_ZERO.replace('{', '{"Invented Supplier Inc": 1, '),         // ...beside all four types
      '{"POSSIBLE_RECOMPETE": 1}',                                    // not a type the scanner counts
      '{"EXPIRY_MOVED": 2}',                                          // some types but not all
      ALL_ZERO.replace('0}', '"3"}'),                                 // a count as a string
      ALL_ZERO.replace('0}', '{"vendor": "Invented Supplier Inc"}}'), // nested
      ALL_ZERO.replace('0}', '[1]}'),                                 // an array (lax would pass it)
      ALL_ZERO.replace('0}', '-1}'),                                  // negative
      ALL_ZERO.replace('0}', '1.5}'),                                 // not whole
      ALL_ZERO.replace('0}', 'null}'),
    ]
    for (const value of bad) {
      assert.equal(
        await refusalCode(
          client,
          `insert into scan_runs (status, events_by_type) values ('ok', $1::jsonb)`,
          [value],
        ),
        CHECK_VIOLATION,
        `events_by_type accepted ${value}, which is not a map of counts`,
      )
    }
    for (const good of ['{}', ALL_ZERO, ONE_EACH, ONE_EACH.replace('1}', '25099}')]) {
      assert.equal(
        await refusalCode(
          client,
          `insert into scan_runs (status, events_by_type) values ('ok', $1::jsonb)`,
          [good],
        ),
        null,
        `events_by_type refused ${good}, which is what the scanner writes`,
      )
    }
  })
})

test('scan_runs refuses a reporting period that is not a fiscal quarter', async () => {
  await withScannerDatabase(async (client) => {
    for (const bad of ['Invented Supplier Inc', '2025-2026-Q5', '2025-26-Q4', '2025-2026-Q4 ', '']) {
      assert.equal(
        await refusalCode(
          client,
          `insert into scan_runs (status, newest_reporting_period) values ('ok', $1)`,
          [bad],
        ),
        CHECK_VIOLATION,
        `newest_reporting_period accepted "${bad}"`,
      )
    }
    for (const good of ['2025-2026-Q4', null]) {
      assert.equal(
        await refusalCode(
          client,
          `insert into scan_runs (status, newest_reporting_period) values ('ok', $1)`,
          [good],
        ),
        null,
        `newest_reporting_period refused ${good}`,
      )
    }
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
    // bigint ids arrive as strings, and '9' < '10' is false as text: this
    // failed the day a rebuilt table's ids crossed from 9 to 10 (18 September
    // 2026). Compared as numbers.
    assert.ok(BigInt(gone) < BigInt(alive), 'bigserial should be handing out increasing ids')

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
    assert.ok(BigInt(alive) < BigInt(alsoGone), 'the second missing id must be the LATER of the pair')
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

test('contract_snapshot does not make the pair unique, because it can repeat', async () => {
  await withScannerDatabase(async (client) => {
    // Outside review, 18 September 2026, asked whether the pair should be unique
    // here as it is in contract_refs. It must not be: see the comment above
    // contract_snapshot in 0004. A watch resolves through contract_refs, whose
    // primary key is the pair; this row's reference is only the latest one.
    const runId = await makeRun(client)
    assert.equal(await insertSnapshot(client, snapshotRow(runId)), null)
    assert.equal(
      await insertSnapshot(client, snapshotRow(runId, { contract_key: 'org-a::PID-002' })),
      null,
      'a second contract under the same (buyer_org_code, reference_number) was refused; ' +
        'on real data that rolls back the whole week',
    )
  })
})
