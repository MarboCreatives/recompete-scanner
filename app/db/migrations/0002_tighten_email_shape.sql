-- app/db/migrations/0002_tighten_email_shape.sql
--
-- Replaces the LIKE-based email shape rule with a regular expression that is a
-- direct translation of normalizeEmail()'s.
--
-- Why this exists. A differential test runs a corpus of addresses through both
-- normalizeEmail() and the real constraint and compares the two answers. The
-- LIKE pattern in 0001 was a crude approximation, and the test found it would
-- store `user@@example.com` and `jon @example.com`. Neither is an address.
--
-- That direction is not a lockout, so nobody was harmed; the dangerous
-- direction, the constraint being stricter than the code, was and remains
-- clean. But these constraints are the last line of defence, not a formality.
-- The scanner, a future migration, and a statement typed into the Neon console
-- all write to these tables without passing through normalizeEmail. A backstop
-- that accepts `jon @example.com` is not doing the job it exists for.
--
-- The pattern below is the POSIX form of the application's regex:
--
--   JavaScript  ^[^\s@]+@[^\s@]+\.[^\s@]{2,}$
--   PostgreSQL  ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$
--
-- Read it as: one or more characters that are neither whitespace nor an at
-- sign; an at sign; the same again; a dot; then at least two more. That
-- requires exactly one at sign, forbids whitespace anywhere, and keeps the
-- two-character minimum after the final dot which was measured on 2 September
-- 2026 as the difference between accepting and refusing `abc@d.e`.
--
-- 0001_init.sql is not edited. It has been applied, and an applied migration is
-- never changed; see db/README.md rule 2.

ALTER TABLE users
  DROP CONSTRAINT users_email_normalised,
  ADD CONSTRAINT users_email_normalised CHECK (
    email = lower(btrim(email))
    AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'
    AND char_length(email) BETWEEN 6 AND 254
  );

ALTER TABLE sign_in_tokens
  DROP CONSTRAINT sign_in_tokens_email_shape,
  ADD CONSTRAINT sign_in_tokens_email_shape CHECK (
    email = lower(btrim(email))
    AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'
    AND char_length(email) BETWEEN 6 AND 254
  );
