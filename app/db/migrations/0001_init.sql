-- app/db/migrations/0001_init.sql
-- Applied once by scripts/migrate.mjs over DATABASE_URL_UNPOOLED, as one string,
-- inside BEGIN/COMMIT, under a session advisory lock.
--
-- schema_migrations is deliberately NOT created in this file. scripts/migrate.mjs
-- owns it and creates it before this file runs. One table, one creator; creating
-- it in both places would fail on SQLSTATE 42P07 and roll back the whole first
-- deploy.
--
-- Rules this file encodes:
--   * no credential column of any kind anywhere; sign in is by emailed link only
--   * only SHA-256 hex digests of secrets are stored, never a usable secret
--   * every table describing a person cascades from users(id), so account
--     deletion is one DELETE plus one tidy-up
--   * watch_items store keys, never display names; names are resolved and
--     suppression-checked at the display path
--   * events are shared facts about contracts and vendors, not personal data, so
--     they do not cascade from users and are not removed with an account
--   * there is no deleted_at, is_active, disabled or archived column anywhere,
--     because deletion means deletion

-- One row per person. Created only when a sign-in link is confirmed, never when
-- one is requested, so an address that never confirmed never lands here.
CREATE TABLE users (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at  timestamptz,
  CONSTRAINT users_email_unique UNIQUE (email),
  CONSTRAINT users_email_normalised CHECK (
    email = lower(btrim(email))
    AND email LIKE '%_@_%.__%'
    AND char_length(email) BETWEEN 6 AND 254
  )
);

-- Pending sign-in links. No foreign key to users, because the person may not have
-- an account yet. Removed on use, on account deletion, and by the sweep.
--
-- sign_in_tokens_email_shape is deliberately identical to the shape half of
-- users_email_normalised. If the two disagreed, an address could be accepted
-- here, emailed a link, then rejected on the users insert after the token was
-- already burned, locking that person out with no way through. Measured against
-- this database on 2 September 2026: LIKE '%_@_%.__%' rejects abc@d.e and a@b.c,
-- and accepts ab@c.de. The JavaScript validator must accept exactly the same set.
CREATE TABLE sign_in_tokens (
  token_hash  text        PRIMARY KEY,
  email       text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  CONSTRAINT sign_in_tokens_hash_shape CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sign_in_tokens_email_shape CHECK (
    email = lower(btrim(email))
    AND email LIKE '%_@_%.__%'
    AND char_length(email) BETWEEN 6 AND 254
  ),
  CONSTRAINT sign_in_tokens_expiry CHECK (expires_at > created_at)
);
CREATE INDEX sign_in_tokens_email_created_idx ON sign_in_tokens (email, created_at);
CREATE INDEX sign_in_tokens_created_idx       ON sign_in_tokens (created_at);
CREATE INDEX sign_in_tokens_expires_idx       ON sign_in_tokens (expires_at);

-- Signed-in devices. The cookie carries the raw random value; this row carries
-- only its SHA-256 hex, so reading the database yields nothing usable.
CREATE TABLE sessions (
  token_hash  text        PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  CONSTRAINT sessions_hash_shape CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sessions_expiry CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_id_idx    ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
-- Deliberately absent: ip, user_agent, last_seen_at. A column nothing writes is a
-- lie in the schema, and an address tied to an email is personal data not needed.

-- What a person follows. target_key is reference_number for a contract and
-- vendor_key for a vendor. No display name column, on purpose.
CREATE TABLE watch_items (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text        NOT NULL,
  target_key  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT watch_items_kind_check CHECK (kind IN ('contract', 'vendor')),
  CONSTRAINT watch_items_target_len CHECK (char_length(target_key) BETWEEN 1 AND 200),
  CONSTRAINT watch_items_unique UNIQUE (user_id, kind, target_key)
);
CREATE INDEX watch_items_target_idx ON watch_items (kind, target_key);

-- One row per person, created at first sign in. Defaults follow the recorded
-- decision: daily, sent only when there is something new. consent_given_at is the
-- CASL express-consent timestamp; NULL means no alert email may ever be sent.
-- The columns exist now so the schema does not change under a live user at M4.
CREATE TABLE alert_preferences (
  user_id               uuid          PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  frequency             text          NOT NULL DEFAULT 'daily',
  min_contract_value    numeric(14,2) NOT NULL DEFAULT 0,
  consent_given_at      timestamptz,
  consent_text_version  text,
  updated_at            timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT alert_preferences_frequency_check CHECK (frequency IN ('daily', 'weekly', 'off')),
  CONSTRAINT alert_preferences_min_value_check CHECK (min_contract_value >= 0)
);

-- Facts about contracts and vendors, written by the scanner from Iteration 2.
-- No user_id: a person's link to an event is through watch_items (what they
-- follow) and event_deliveries (what they were shown).
--
-- events_no_buyer_name is a tripwire for the rule that buyer_name is never
-- published. It matches the whole serialised payload as text, so a nested or
-- camelCase key is caught too. It is a tripwire, not a proof; the display path
-- remains the enforcement point. Measured against this database on 2 September
-- 2026: the constraint is accepted and does fire, refusing a violating insert.
CREATE TABLE events (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    text        NOT NULL,
  contract_ref  text,
  vendor_key    text,
  dedupe_key    text        NOT NULL,
  occurred_at   timestamptz NOT NULL,
  detected_at   timestamptz NOT NULL DEFAULT now(),
  source_url    text,
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT events_type_check CHECK (event_type IN (
    'EXPIRY_MOVED', 'VALUE_CHANGED', 'CONTRACT_GONE', 'NEW_AWARD',
    'POSSIBLE_RECOMPETE', 'ACAN_POSTED', 'NEWS_MENTION')),
  CONSTRAINT events_dedupe_unique UNIQUE (dedupe_key),
  CONSTRAINT events_has_subject CHECK (contract_ref IS NOT NULL OR vendor_key IS NOT NULL),
  CONSTRAINT events_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT events_no_buyer_name CHECK (
    payload::text NOT ILIKE '%buyer_name%' AND payload::text NOT ILIKE '%buyername%'
  )
);
CREATE INDEX events_contract_ref_idx ON events (contract_ref) WHERE contract_ref IS NOT NULL;
CREATE INDEX events_vendor_key_idx   ON events (vendor_key)   WHERE vendor_key   IS NOT NULL;
CREATE INDEX events_detected_at_idx  ON events (detected_at DESC);

-- Which event reached which person by which channel. Feed rows are written when
-- shown (Iteration 2); email rows when a digest is sent (Iteration 4).
CREATE TABLE event_deliveries (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  event_id      uuid        NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  channel       text        NOT NULL,
  delivered_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_deliveries_channel_check CHECK (channel IN ('feed', 'email')),
  CONSTRAINT event_deliveries_unique UNIQUE (user_id, event_id, channel)
);
CREATE INDEX event_deliveries_user_idx ON event_deliveries (user_id, delivered_at DESC);

-- Account deletion is therefore exactly:
--   DELETE FROM users WHERE id = $1;              -- cascades sessions, watch_items,
--                                                 -- alert_preferences, event_deliveries
--   DELETE FROM sign_in_tokens WHERE email = $2;  -- no foreign key, so explicit
--
-- gen_random_uuid() is core PostgreSQL from version 13; this database is 18.6.
