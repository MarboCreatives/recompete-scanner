-- app/db/migrations/0004_scanner.sql
--
-- The scanner's half of the database. M2-DESIGN sections 5.1 to 5.5.
--
-- Three new tables, two new columns on events, and one least-privilege role.
-- Nothing here is written by the app and nothing here holds personal data.
-- The scanner and the app meet at these tables and nowhere else.
--
-- ## What this file deliberately does NOT contain
--
-- A password. `scanner_writer` is created NOLOGIN with no password, so applying
-- this file cannot put a usable credential anywhere, and this file being public
-- gives nobody anything. The password is set once, by hand, out of band:
--
--     ALTER ROLE scanner_writer WITH LOGIN PASSWORD '<generated, never written down>';
--
-- until which point the role exists and can do nothing at all. That ordering is
-- the point: a migration is reviewed in a browser and lives in a public
-- repository, and a secret in one is a secret published.
--
-- ## Why the CHECK constraints are here at all
--
-- They are tripwires, not the enforcement point, exactly as events_no_buyer_name
-- is in 0001_init.sql. Suppression is enforced in the scanner's snapshot.py
-- before a row is ever built, and the app gates names again at the display path.
-- A constraint cannot recognise a person's name. What it CAN do is refuse a row
-- whose shape proves the writer above it is wired wrongly, and do it in the one
-- place a future code path cannot route around. Every constraint below was run
-- against a violating row on recompete_test and observed to refuse it; that is
-- recorded in PROGRESS.md.

-- --------------------------------------------------------------------------
-- scan_runs — one row per scan attempt
-- --------------------------------------------------------------------------
--
-- Created first, because contract_snapshot and contract_refs point at it.
--
-- A run that refuses or fails still gets a row. That is the whole reason the
-- table exists: M2-DESIGN 8.2 and CODING-STANDARDS 4 require the feed to say
-- "the last check did not complete" rather than show an empty list that reads
-- as "nothing changed". The feed cannot tell those apart without a row here.

CREATE TABLE scan_runs (
  id                       bigserial   PRIMARY KEY,
  started_at               timestamptz NOT NULL DEFAULT now(),
  finished_at              timestamptz,
  status                   text        NOT NULL,
  source_rows              int,
  live_contracts           int,
  newest_reporting_period  text,
  events_by_type           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  refusal_reason           text,

  CONSTRAINT scan_runs_status_check CHECK (
    status IN ('baseline', 'ok', 'refused', 'failed')
  ),

  -- A fixed code from a short list, never free text (M2-DESIGN 5.3). The four
  -- codes are the four refusal rules of M2-DESIGN 6.6, in order:
  --   live_count_drop  live contracts fell by more than 10% against the last run
  --   gone_rate        more than 5% of previous live contracts would go at once
  --   drift            vendor/ no longer matches the site's rules (4.2)
  --   self_test        a self-test failed
  -- Free text here would eventually carry a vendor name into a public table.
  CONSTRAINT scan_runs_refusal_reason_check CHECK (
    refusal_reason IS NULL
    OR refusal_reason IN ('live_count_drop', 'gone_rate', 'drift', 'self_test')
  ),

  -- The two fields cannot disagree. A refused run with no reason is a run
  -- nobody can act on; a reason on an ok run means the writer took the refusal
  -- branch and committed anyway.
  CONSTRAINT scan_runs_refused_has_reason CHECK (
    (status = 'refused') = (refusal_reason IS NOT NULL)
  ),

  CONSTRAINT scan_runs_finish_after_start CHECK (
    finished_at IS NULL OR finished_at >= started_at
  ),

  CONSTRAINT scan_runs_counts_nonneg CHECK (
    (source_rows    IS NULL OR source_rows    >= 0)
    AND (live_contracts IS NULL OR live_contracts >= 0)
  ),

  -- Counts only, never names (M2-DESIGN 7). Either '{}' (the default, for a
  -- run that stopped before it counted anything) or all four event types the
  -- scanner emits, each a whole number, zero or more. scanner/diff.py's
  -- events_by_type() writes exactly that shape, zeros included, because "we
  -- found none" and "we did not look" are different statements.
  -- scanner/tests/test_schema_fit.py pins these four names to diff.EVENT_TYPES.
  --
  -- The first version checked only that the value was an object, and its
  -- comment claimed that meant "keys are event types and values are numbers".
  -- It did not: '{"vendor": "<a name>"}' was accepted, and so was a name used
  -- as a key. Found by an outside review, 18 September 2026.
  --
  -- The CASE is load-bearing: jsonb - text[] raises 22023 on a scalar, which
  -- would turn a refused row into a different error. strict, not lax: lax
  -- unwraps arrays, so {"NEW_AWARD": [1]} would pass.
  CONSTRAINT scan_runs_events_by_type_counts CHECK (
    CASE WHEN jsonb_typeof(events_by_type) = 'object' THEN
      (events_by_type - ARRAY['EXPIRY_MOVED', 'VALUE_CHANGED', 'CONTRACT_GONE', 'NEW_AWARD']) = '{}'::jsonb
      AND (events_by_type = '{}'::jsonb
           OR events_by_type ?& ARRAY['EXPIRY_MOVED', 'VALUE_CHANGED', 'CONTRACT_GONE', 'NEW_AWARD'])
      AND NOT jsonb_path_exists(events_by_type,
            'strict $.* ? (@.type() != "number" || @ < 0 || @ != @.floor())')
    ELSE false END
  ),

  -- "Data through {quarter}" (M2-DESIGN 8.2): the fiscal year and quarter the
  -- source's reporting_period column carries, as in 2025-2026-Q4. Any other
  -- shape means a writer copied the wrong field, possibly one holding a name.
  -- The writer must not lean on this: ingest passes the value through
  -- unstripped, and one refused value rolls back the whole week. It should
  -- write only values of this shape, and NULL otherwise.
  CONSTRAINT scan_runs_reporting_period_shape CHECK (
    newest_reporting_period ~ '^[0-9]{4}-[0-9]{4}-Q[1-4]$'
  )
);

-- "What is the last run that produced a usable snapshot" is the question the
-- diff asks on every run and the feed asks on every page.
CREATE INDEX scan_runs_status_started_idx ON scan_runs (status, started_at DESC);


-- --------------------------------------------------------------------------
-- contract_snapshot — the current state of every live contract
-- --------------------------------------------------------------------------
--
-- Rows are updated in place each run. A contract that leaves the published data
-- keeps its row with an old last_seen_run, so a watch on it still resolves to
-- something rather than to nothing (M2-DESIGN 5.1).
--
-- There is no vendor_name column and no buyer_name column. vendor_display is
-- the name AFTER suppression, which for a private individual is the literal
-- string in contract_snapshot_withheld_pairing below and never their name.
--
-- (buyer_org_code, reference_number) is deliberately NOT unique here. It is
-- the LATEST amendment's reference, for display and the source link, not an
-- identity: two procurement ids can share one, and a later contract can reuse a
-- department's reference while this table keeps the older row. G23 measured
-- the pair unique on one day's live set, not across time, and a UNIQUE would
-- turn one such row into a refused insert that rolls back the whole week,
-- every week (M2-DESIGN 6 rule 7). A watch resolves through contract_refs,
-- whose primary key IS the pair. The test suite pins this.

CREATE TABLE contract_snapshot (
  contract_key      text          PRIMARY KEY,
  buyer_org_code    text          NOT NULL,
  reference_number  text          NOT NULL,
  buyer_org         text          NOT NULL,
  vendor_key        text          NOT NULL,
  vendor_display    text          NOT NULL,
  category_key      text          NOT NULL,
  contract_value    numeric(16,2),
  end_date          date,
  amendment_count   int           NOT NULL,
  first_seen_run    bigint        NOT NULL REFERENCES scan_runs(id),
  last_seen_run     bigint        NOT NULL REFERENCES scan_runs(id),

  -- The site blanks vendor_key and substitutes this exact string in the same
  -- breath (build_site.suppress_individuals). One without the other is the
  -- signature of half-applied suppression: a blank key with a real name means
  -- the name survived, and the withheld label with a real key means the person
  -- still has a supplier page and a watchable identity.
  --
  -- The string is spelled out rather than referenced because a constraint
  -- cannot import a Python constant. scanner/tests asserts the two agree, so
  -- they cannot drift apart silently.
  CONSTRAINT contract_snapshot_withheld_pairing CHECK (
    (vendor_key = '') = (vendor_display = 'Individual supplier (name withheld)')
  ),

  -- The same idea as events_no_buyer_name in 0001_init.sql, and the same
  -- limits: it recognises the FIELD, not a person. ingest.py does not collect
  -- buyer_name at all, which is the real protection; this refuses a row if some
  -- future writer serialises a raw source record into a text column and lands
  -- the field name with it.
  --
  -- Written with || rather than concat_ws because concat_ws is STABLE, not
  -- IMMUTABLE, and a CHECK should give the same answer whatever the session's
  -- settings. (PostgreSQL 18 does accept a STABLE function in a CHECK; an
  -- earlier version of this comment said it refused one. Measured 18 September
  -- 2026.) Every column named here is NOT NULL, so || cannot collapse the whole
  -- expression to NULL
  -- (a NULL CHECK passes, which would switch this off in silence). Any nullable
  -- column added to this table later must be wrapped in coalesce() before being
  -- added here.
  CONSTRAINT contract_snapshot_no_buyer_name CHECK (
    (contract_key || ' ' || buyer_org_code || ' ' || reference_number || ' '
      || buyer_org || ' ' || vendor_key || ' ' || vendor_display || ' '
      || category_key) NOT ILIKE '%buyer_name%'
    AND (contract_key || ' ' || buyer_org_code || ' ' || reference_number || ' '
      || buyer_org || ' ' || vendor_key || ' ' || vendor_display || ' '
      || category_key) NOT ILIKE '%buyername%'
  ),

  -- first_seen_run is set once and never moved; last_seen_run only goes
  -- forward. The pair going backwards means an update wrote the wrong column.
  CONSTRAINT contract_snapshot_run_order CHECK (first_seen_run <= last_seen_run),

  -- ingest.deduplicate() counts the rows it collapsed and the winning row is
  -- one of them, so the floor is 1. A 0 means the count was never set.
  CONSTRAINT contract_snapshot_amendment_count CHECK (amendment_count >= 1)
);

-- A supplier watch resolves through vendor_key. Partial, because an individual
-- supplier's key is the empty string and there is no watch that can match it.
CREATE INDEX contract_snapshot_vendor_key_idx
  ON contract_snapshot (vendor_key) WHERE vendor_key <> '';

-- CONTRACT_GONE and the expiry window both scan by end date.
CREATE INDEX contract_snapshot_end_date_idx ON contract_snapshot (end_date);

CREATE INDEX contract_snapshot_last_seen_run_idx ON contract_snapshot (last_seen_run);


-- --------------------------------------------------------------------------
-- contract_refs — every reference number a contract has ever had
-- --------------------------------------------------------------------------
--
-- This table is what replaces the MILESTONES task "carry a watch forward when a
-- contract is amended" (M2-DESIGN 5.2). That task had the scanner rewriting the
-- stored watch key inside watch_items. This does the same job without the
-- scanner ever touching a table that holds personal data: a watch key is
-- "{org},{ref}" forever, and the lookup moves instead of the key.
--
-- The pair is the primary key because G23 says a reference number alone is not
-- unique; (buyer_org_code, reference_number) is. That pair IS the watch key, so
-- this table is keyed on exactly what a watch stores.

CREATE TABLE contract_refs (
  buyer_org_code    text    NOT NULL,
  reference_number  text    NOT NULL,
  contract_key      text    NOT NULL REFERENCES contract_snapshot(contract_key),
  first_seen_run    bigint  NOT NULL REFERENCES scan_runs(id),

  CONSTRAINT contract_refs_pkey PRIMARY KEY (buyer_org_code, reference_number),

  -- Half an empty pair is not a watch key, it is a row that will match the
  -- wrong contract or none. ingest drops rows with no reference number; this
  -- refuses one that arrives anyway.
  CONSTRAINT contract_refs_halves_present CHECK (
    buyer_org_code <> '' AND reference_number <> ''
  )
);

-- "Every reference this contract has been published under", for the source
-- link and for the feed's per-contract history.
CREATE INDEX contract_refs_contract_key_idx ON contract_refs (contract_key);


-- --------------------------------------------------------------------------
-- events — two new columns
-- --------------------------------------------------------------------------
--
-- contract_ref keeps holding "{org},{ref}" AS AT THE MOMENT OF THE EVENT, which
-- is what the source link and the displayed line need. contract_key is the
-- identity that survives an amendment, which is what the feed joins on. They
-- are different questions and neither answers the other.
--
-- Nullable, because a NEW_AWARD to a vendor is about the vendor and events
-- written before this migration have no key to backfill from. There is no
-- foreign key to contract_snapshot on purpose: an event is a historical fact
-- and must not become unwritable, or worse silently deleted, because the
-- contract row it refers to was reorganised later.

ALTER TABLE events
  ADD COLUMN contract_key text,
  ADD COLUMN scan_run_id  bigint REFERENCES scan_runs(id);

CREATE INDEX events_contract_key_idx
  ON events (contract_key) WHERE contract_key IS NOT NULL;

CREATE INDEX events_scan_run_id_idx
  ON events (scan_run_id) WHERE scan_run_id IS NOT NULL;


-- --------------------------------------------------------------------------
-- scanner_writer — the least-privilege role the weekly run connects as
-- --------------------------------------------------------------------------
--
-- M2-DESIGN 5.5. The grants below are the whole of what the scanner may do.
-- Everything not granted is refused, because PostgreSQL grants a new role
-- nothing on an existing table; there is no privilege to revoke, only ones not
-- to give. That is worth stating because it is the reason there is no REVOKE
-- statement here, and the absence of one reads like an omission otherwise.
--
-- Specifically NOT granted, and tested for: users, sessions, sign_in_tokens,
-- watch_items, alert_preferences, event_deliveries, schema_migrations. The
-- scanner writes public facts about contracts. It has no business reading who
-- is watching them, and a connection string leaking out of a public
-- repository's Actions secret should cost the project a rewritten snapshot,
-- not its users' addresses. The test suite checks the whole of what the role
-- holds, read from the catalogs, so a table added later is covered too.
--
-- THE ROLE IS CLUSTER-WIDE. neondb, recompete_test and postgres share one
-- scanner_writer, and it already exists: the first apply against
-- recompete_test created it on 17 September 2026. NOLOGIN is guaranteed only
-- when this block creates it. This file deliberately never changes an
-- existing role's LOGIN or password: it runs against the cluster again
-- whenever recompete_test is rebuilt (db/README rule 6), and after the
-- out-of-band ALTER ROLE ... LOGIN above, a "normalising" ALTER ROLE here would
-- switch the production scanner off. The test suite refuses one.
--
-- CONNECT is PUBLIC's by default on every database in this project, so once
-- the role has LOGIN it can open a session on postgres and recompete_test too.
-- There it reaches only what PUBLIC reaches, and on recompete_test the same
-- grants as here, over invented rows. Revoking PUBLIC's CONNECT would also cut
-- off Neon's own neon_auth and neon_service roles, so it is left as it is.
--
-- The EXCEPTION absorbs a race the advisory lock in migrate.mjs cannot see:
-- that lock is per database, roles are per cluster. A second database's run
-- creating the role at the same moment makes CREATE ROLE wait on the other
-- transaction and then fail with unique_violation (duplicate_object only when
-- the other run committed before this one looked). Either way the role exists,
-- which is all this block wants.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scanner_writer') THEN
    CREATE ROLE scanner_writer NOLOGIN;
  END IF;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;

GRANT USAGE ON SCHEMA public TO scanner_writer;

GRANT SELECT, INSERT, UPDATE ON contract_snapshot TO scanner_writer;
GRANT SELECT, INSERT, UPDATE ON contract_refs     TO scanner_writer;
GRANT SELECT, INSERT, UPDATE ON scan_runs         TO scanner_writer;

-- SELECT and INSERT only. An event is a fact that was true when it was
-- detected; rewriting one after the fact is not a thing the scanner should be
-- able to do, and DELETE is how a bug turns into lost history.
GRANT SELECT, INSERT ON events TO scanner_writer;

-- bigserial hangs a sequence off the column, and INSERT on the table is not
-- enough to call nextval() on it. Without this grant every scan_runs insert
-- fails with "permission denied for sequence scan_runs_id_seq" — which is the
-- kind of fault that only shows up on the first real run, at 07:00 on a Monday.
GRANT USAGE ON SEQUENCE scan_runs_id_seq TO scanner_writer;


-- --------------------------------------------------------------------------
-- Letting the test suite become the role
-- --------------------------------------------------------------------------
--
-- The grants above are worth nothing unless something checks them, and the only
-- check worth having is the negative one: that scanner_writer is REFUSED the
-- six tables describing people. To check that, a test has to run a statement AS
-- the role.
--
-- The alternative is a second secret — give scanner_writer a password, store it,
-- and have the suite connect with it. tests/helpers.mjs exists because this
-- project already decided against that shape once: it derives the test
-- connection from the ordinary one rather than storing another credential. A
-- test that cannot run without a secret nobody has set is a test that quietly
-- does not run.
--
-- So the migration grants the migrating role the right to SET ROLE into
-- scanner_writer. Read the direction carefully, because it is the whole safety
-- argument: this lets the owner become the scanner, never the scanner become the
-- owner. The owner already owns every table here and can do strictly more than
-- scanner_writer can, so it gains no privilege it did not have. What it gains is
-- the ability to drop DOWN to the scanner's privileges and find out what they
-- really are.
--
-- WITH SET TRUE and INHERIT FALSE, deliberately. Measured against this
-- database on 17 September 2026: PostgreSQL 18 grants a role's creator
-- ADMIN but neither SET nor INHERIT, so `SET ROLE scanner_writer` was refused
-- with 42501 from the role GUC's check hook until this statement existed. SET
-- makes the switch possible and explicit; INHERIT would make the owner silently
-- carry the scanner's grants in every ordinary session, which is a change to how
-- the app's own connection behaves and is not wanted.
--
-- INHERIT FALSE must be written out. Left unsaid, it takes the member's own
-- rolinherit, which is true for neondb_owner: the first version of this line
-- granted INHERIT while this comment said it did not. Measured, and found by
-- an outside review, 18 September 2026. Re-granting updates the existing
-- membership in place.
--
-- CURRENT_USER rather than the name neondb_owner, so this says "whoever migrates
-- this database" rather than encoding one hosting provider's naming.
GRANT scanner_writer TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
